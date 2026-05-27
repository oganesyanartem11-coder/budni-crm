/**
 * Boris briefings & metrics queries — Sprint 7.16.B (subagent B3).
 *
 * Используются на странице /boris (ADMIN_PRO only) для отображения истории
 * утренних брифингов / самоанализа и метрик Action-Бориса за 7 дней.
 *
 * Decimal → number конверсия на границе (Number(...)) — Decimal не сериализуется
 * через server→client props в Next.js без явного преобразования.
 */

import { prisma } from '@/lib/db/prisma'
import { BorisMetricSource } from '@prisma/client'
import type { BriefingType, BorisEventType } from '@prisma/client'
import { getFinancialWeek } from '@/lib/utils/week'

// ============================================================
// Recent briefings
// ============================================================

export type BorisBriefingWithRecipient = Awaited<
  ReturnType<typeof listRecentBriefings>
>[number]

/**
 * Последние брифинги с указанным типом (или вообще все, если type не задан).
 * Сортировка по generatedAt DESC. limit по умолчанию 30.
 */
export async function listRecentBriefings(opts?: {
  type?: BriefingType
  limit?: number
}) {
  const limit = opts?.limit ?? 30
  return prisma.borisBriefing.findMany({
    where: opts?.type ? { type: opts.type } : undefined,
    orderBy: { generatedAt: 'desc' },
    take: limit,
    include: {
      recipient: { select: { id: true, name: true } },
    },
  })
}

/**
 * Один briefing по id с recipient.
 */
export async function getBriefingById(id: string) {
  return prisma.borisBriefing.findUnique({
    where: { id },
    include: {
      recipient: { select: { id: true, name: true } },
    },
  })
}

// ============================================================
// Weekly metrics summary
// ============================================================

export type WeeklyMetricsSummary = {
  totalCalls: number
  totalCostUsd: number
  errorRate: number
  topTools: { toolName: string; count: number }[]
  totalInputTokens: number
  totalOutputTokens: number
}

/**
 * Сводка метрик Action-Бориса за последние 7 суток. Используется на табе
 * «Метрики Action-Бориса» страницы /boris.
 *
 * - totalCalls — count(*) всех записей в окне
 * - totalCostUsd — sum(costUsd), Decimal → number на границе
 * - errorRate — доля записей с ok=false в процентах (0 если totalCalls=0)
 * - topTools — top-5 toolName по числу вызовов в источнике ACTION_EXECUTOR
 *   (toolName IS NOT NULL); это даёт картину «какие инструменты Борис реально дёргает»
 * - totalInputTokens / totalOutputTokens — sum, Int
 */
export async function getWeeklyMetricsSummary(): Promise<WeeklyMetricsSummary> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Параллельно: общий aggregate + count(errors) + groupBy по toolName.
  const [agg, errorCount, toolsGrouped] = await Promise.all([
    prisma.borisMetrics.aggregate({
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: { _all: true },
      _sum: {
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
      },
    }),
    prisma.borisMetrics.count({
      where: { createdAt: { gte: sevenDaysAgo }, ok: false },
    }),
    prisma.borisMetrics.groupBy({
      by: ['toolName'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        toolName: { not: null },
        source: 'ACTION_EXECUTOR',
      },
      _count: { _all: true },
      orderBy: { _count: { toolName: 'desc' } },
      take: 5,
    }),
  ])

  const totalCalls = agg._count._all
  const totalCostUsd = Number(agg._sum.costUsd ?? 0)
  const totalInputTokens = agg._sum.inputTokens ?? 0
  const totalOutputTokens = agg._sum.outputTokens ?? 0
  const errorRate = totalCalls === 0 ? 0 : (errorCount / totalCalls) * 100

  const topTools = toolsGrouped
    // groupBy с фильтром { not: null } гарантирует не-null toolName,
    // но Prisma тип всё равно `string | null` — явно отфильтруем для type-safety.
    .filter((g): g is typeof g & { toolName: string } => g.toolName !== null)
    .map((g) => ({ toolName: g.toolName, count: g._count._all }))

  return {
    totalCalls,
    totalCostUsd,
    errorRate,
    topTools,
    totalInputTokens,
    totalOutputTokens,
  }
}

// ============================================================
// 7.16.C — Командный Борис: queries для UI таба «Команда»
// ============================================================

/**
 * Briefings, относящиеся к 4 каналам Командного Бориса (TEAM_*).
 * Используется на табе «Команда» в /boris.
 *
 * - types: подмножество BriefingType (default — все 4 team-типа).
 * - limit: default 30.
 * - Сортировка по generatedAt DESC, recipient include — как в listRecentBriefings.
 */
export async function listRecentBriefingsForChannels(opts?: {
  types?: BriefingType[]
  limit?: number
}) {
  const types =
    opts?.types ??
    (['TEAM_LIVE', 'TEAM_EVENING', 'TEAM_FRIDAY', 'TEAM_ALERT'] as BriefingType[])
  const limit = opts?.limit ?? 30
  return prisma.borisBriefing.findMany({
    where: { type: { in: types } },
    orderBy: { generatedAt: 'desc' },
    take: limit,
    include: {
      recipient: { select: { id: true, name: true } },
    },
  })
}

export type TeamWeeklyMetrics = {
  weekFrom: Date
  weekTo: Date
  byChannel: Array<{
    source: 'TEAM_LIVE' | 'TEAM_EVENING' | 'TEAM_FRIDAY' | 'TEAM_ALERT'
    callCount: number
    costUsd: number
    inputTokens: number
    outputTokens: number
  }>
  eventCount: number
  silentCount: number
}

/**
 * Метрики Командного Бориса за финансовую неделю (Сб 00:00 МСК — Пт 23:59 МСК).
 *
 * - byChannel: groupBy по source ∈ TEAM_*, callCount + costUsd + tokens из BorisMetrics.
 * - eventCount: count(BorisEventLog) c createdAt в этой неделе.
 * - silentCount: count(BorisBriefing) c type ∈ TEAM_* и content='' в этой неделе
 *   (SILENT-решения — Боря осознанно промолчал).
 */
export async function getTeamWeeklyMetrics(): Promise<TeamWeeklyMetrics> {
  const { from, to } = getFinancialWeek(new Date())

  const teamSources: BorisMetricSource[] = [
    BorisMetricSource.TEAM_LIVE,
    BorisMetricSource.TEAM_EVENING,
    BorisMetricSource.TEAM_FRIDAY,
    BorisMetricSource.TEAM_ALERT,
  ]

  const [metricsGrouped, eventCount, silentCount] = await Promise.all([
    prisma.borisMetrics.groupBy({
      by: ['source'],
      where: {
        createdAt: { gte: from, lte: to },
        source: { in: teamSources },
      },
      _count: { _all: true },
      _sum: {
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
      },
    }),
    prisma.borisEventLog.count({
      where: { createdAt: { gte: from, lte: to } },
    }),
    prisma.borisBriefing.count({
      where: {
        type: { in: ['TEAM_LIVE', 'TEAM_EVENING', 'TEAM_FRIDAY', 'TEAM_ALERT'] },
        content: '',
        generatedAt: { gte: from, lte: to },
      },
    }),
  ])

  // Нормализуем результат: гарантированно по записи на каждый из 4 каналов
  // (0 если данных в этой неделе не было — UI рисует таблицу одинаково).
  const byChannelMap = new Map<
    BorisMetricSource,
    {
      callCount: number
      costUsd: number
      inputTokens: number
      outputTokens: number
    }
  >()
  for (const row of metricsGrouped) {
    byChannelMap.set(row.source, {
      callCount: row._count._all,
      costUsd: Number(row._sum.costUsd ?? 0),
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    })
  }

  const byChannel = teamSources.map((source) => {
    const v = byChannelMap.get(source) ?? {
      callCount: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    return {
      source: source as 'TEAM_LIVE' | 'TEAM_EVENING' | 'TEAM_FRIDAY' | 'TEAM_ALERT',
      ...v,
    }
  })

  return {
    weekFrom: from,
    weekTo: to,
    byChannel,
    eventCount,
    silentCount,
  }
}

export type BorisEventWithRefs = Awaited<
  ReturnType<typeof listRecentBorisEvents>
>[number]

/**
 * Последние события Командного Бориса (журнал BorisEventLog).
 * Используется на табе «Команда» (ADMIN_PRO only).
 *
 * - limit: default 50.
 * - eventTypes: фильтр по подмножеству BorisEventType (default — все).
 * - Сортировка по createdAt DESC.
 * - include client/order/menuCycle (select id+name/...) для отображения связки.
 */
export async function listRecentBorisEvents(opts?: {
  limit?: number
  eventTypes?: BorisEventType[]
}) {
  const limit = opts?.limit ?? 50
  return prisma.borisEventLog.findMany({
    where: opts?.eventTypes ? { eventType: { in: opts.eventTypes } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      client: { select: { id: true, name: true } },
      order: { select: { id: true, deliveryDate: true, mealType: true } },
      menuCycle: { select: { id: true, name: true } },
    },
  })
}
