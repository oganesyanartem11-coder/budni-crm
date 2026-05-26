/**
 * Self-Analysis context builder для Бориса.
 *
 * Собирает агрегаты BorisMetrics за прошедшую финансовую неделю + паттерны
 * по ActivityLog (часто-правленые клиенты) и сравнение с прошлой неделей.
 *
 * Финансовая неделя проекта: Сб 00:00 МСК → Пт 23:59 МСК (см. getFinancialWeek
 * в @/lib/utils/week). Поэтому "последняя завершённая" — это та, которая
 * закончилась в прошлую пятницу 23:59:59.999 МСК.
 *
 * Сейчас (2026-05-26 Вт) → последняя завершённая неделя: Сб 16.05 → Пт 22.05.
 *
 * Спринт 7.16.B, блок B1.4.
 */

import { prisma } from '@/lib/db/prisma'
import { BorisMetricSource } from '@prisma/client'
import { getFinancialWeek, getPreviousFinancialWeek } from '@/lib/utils/week'

const DAY_MS = 24 * 60 * 60 * 1000
const FREQUENTLY_EDITED_MIN_COUNT = 3

export interface SelfAnalysisContext {
  weekStartIso: string
  weekEndIso: string
  summary: {
    totalRequests: number
    mutateActions: number
    mutateFailed: number
    avgDurationMs: number
    totalCostUsd: number
    totalInputTokens: number
    totalOutputTokens: number
  }
  topTools: { toolName: string; count: number }[]
  recentFailures: { toolName: string; errorMessage: string; createdAt: string }[]
  patterns: {
    frequentlyEditedClients: { clientName: string; count: number }[] | null
    weekOverWeekChange: { commandsDelta: number; errorsDelta: number } | null
  }
}

/**
 * Возвращает последнюю ЗАВЕРШЁННУЮ финансовую неделю (Сб 00:00 МСК → Пт 23:59:59.999 МСК).
 *
 * Логика: getFinancialWeek(now) даёт ТЕКУЩУЮ неделю (которая ещё идёт),
 * нам нужна предыдущая. Если now = Сб (только начало новой) — то предыдущая
 * как раз только что завершилась. Если now = Пт ночью — текущая неделя ещё
 * не закрыта, берём предыдущую.
 */
export async function getCurrentFinancialWeek(
  now: Date
): Promise<{ weekStart: Date; weekEnd: Date }> {
  const prev = getPreviousFinancialWeek(now)
  return { weekStart: prev.from, weekEnd: prev.to }
}

/**
 * Считает агрегаты по BorisMetrics за окно. Возвращает summary + сырые counters
 * для weekOverWeekChange (mutate-only).
 */
async function computeWindowAggregates(
  userId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<{
  totalRequests: number
  mutateActions: number
  mutateFailed: number
  avgDurationMs: number
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
}> {
  const rows = await prisma.borisMetrics.findMany({
    where: {
      userId,
      source: { in: [BorisMetricSource.ACTION_CHAT, BorisMetricSource.ACTION_EXECUTOR] },
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    select: {
      source: true,
      ok: true,
      durationMs: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
    },
  })

  const totalRequests = rows.length
  let mutateActions = 0
  let mutateFailed = 0
  let durationSum = 0
  let costSum = 0
  let inputSum = 0
  let outputSum = 0

  for (const r of rows) {
    durationSum += r.durationMs
    inputSum += r.inputTokens
    outputSum += r.outputTokens
    // Prisma Decimal → toNumber() для агрегации; точность Decimal(10,6) для
    // суммы малых значений в JS-числе достаточна (USD недельный масштаб).
    costSum += Number(r.costUsd)
    if (r.source === BorisMetricSource.ACTION_EXECUTOR) {
      mutateActions++
      if (!r.ok) mutateFailed++
    }
  }

  const avgDurationMs = totalRequests > 0 ? Math.round(durationSum / totalRequests) : 0

  return {
    totalRequests,
    mutateActions,
    mutateFailed,
    avgDurationMs,
    totalCostUsd: Math.round(costSum * 1_000_000) / 1_000_000,
    totalInputTokens: inputSum,
    totalOutputTokens: outputSum,
  }
}

export async function buildSelfAnalysisContext(
  userId: string,
  weekStart: Date,
  weekEnd: Date
): Promise<SelfAnalysisContext | null> {
  const summary = await computeWindowAggregates(userId, weekStart, weekEnd)

  // Если за неделю не было ни одного вызова — самоанализ бессмыслен,
  // cron должен пропустить отправку (см. требование в задаче).
  if (summary.totalRequests === 0) {
    return null
  }

  // Top-3 tools по частоте (только успешные/неуспешные mutate, toolName != null).
  const toolGroups = await prisma.borisMetrics.groupBy({
    by: ['toolName'],
    where: {
      userId,
      source: BorisMetricSource.ACTION_EXECUTOR,
      toolName: { not: null },
      createdAt: { gte: weekStart, lte: weekEnd },
    },
    _count: { _all: true },
    orderBy: { _count: { toolName: 'desc' } },
    take: 3,
  })

  const topTools = toolGroups
    .filter((g) => g.toolName !== null)
    .map((g) => ({ toolName: g.toolName as string, count: g._count._all }))

  // Recent failures — последние 5 неуспешных executor-вызовов.
  const failureRows = await prisma.borisMetrics.findMany({
    where: {
      userId,
      source: BorisMetricSource.ACTION_EXECUTOR,
      ok: false,
      createdAt: { gte: weekStart, lte: weekEnd },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { toolName: true, errorMessage: true, createdAt: true },
  })
  const recentFailures = failureRows.map((r) => ({
    toolName: r.toolName ?? 'unknown',
    errorMessage: r.errorMessage ?? '(no message)',
    createdAt: r.createdAt.toISOString(),
  }))

  // Patterns.frequentlyEditedClients: через ActivityLog (entityType='Order')
  // вычисляем какие Order'ы трогал этот юзер, потом группируем по clientId.
  const orderLogs = await prisma.activityLog.findMany({
    where: {
      userId,
      entityType: 'Order',
      createdAt: { gte: weekStart, lte: weekEnd },
    },
    select: { entityId: true },
  })

  let frequentlyEditedClients: { clientName: string; count: number }[] | null = null
  const orderIds = orderLogs
    .map((l) => l.entityId)
    .filter((id): id is string => id !== null && id.length > 0)

  if (orderIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, clientId: true, client: { select: { name: true } } },
    })
    const orderById = new Map(orders.map((o) => [o.id, o]))
    const countsByClient = new Map<string, { clientName: string; count: number }>()
    for (const log of orderLogs) {
      if (!log.entityId) continue
      const order = orderById.get(log.entityId)
      if (!order) continue
      const entry = countsByClient.get(order.clientId)
      if (entry) {
        entry.count++
      } else {
        countsByClient.set(order.clientId, { clientName: order.client.name, count: 1 })
      }
    }
    const filtered = Array.from(countsByClient.values())
      .filter((c) => c.count >= FREQUENTLY_EDITED_MIN_COUNT)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
    frequentlyEditedClients = filtered.length > 0 ? filtered : null
  }

  // Patterns.weekOverWeekChange — сравниваем с предыдущей финансовой неделей
  // (отступ ровно 7 дней назад).
  const prevWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS)
  const prevWeekEnd = new Date(weekEnd.getTime() - 7 * DAY_MS)
  const prevAgg = await computeWindowAggregates(userId, prevWeekStart, prevWeekEnd)
  let weekOverWeekChange: { commandsDelta: number; errorsDelta: number } | null = null
  if (prevAgg.totalRequests > 0) {
    weekOverWeekChange = {
      commandsDelta: summary.totalRequests - prevAgg.totalRequests,
      errorsDelta: summary.mutateFailed - prevAgg.mutateFailed,
    }
  }

  return {
    weekStartIso: weekStart.toISOString(),
    weekEndIso: weekEnd.toISOString(),
    summary,
    topTools,
    recentFailures,
    patterns: {
      frequentlyEditedClients,
      weekOverWeekChange,
    },
  }
}
