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
import type { BriefingType } from '@prisma/client'

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
