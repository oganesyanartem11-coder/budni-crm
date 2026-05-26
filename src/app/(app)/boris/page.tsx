import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import {
  listRecentBriefings,
  getWeeklyMetricsSummary,
} from '@/lib/db/queries/boris-briefings'
import { BorisHistoryView } from './_components/boris-history-view'

/**
 * /boris — admin-инспектор брифингов и метрик Action-Бориса.
 * Строго ADMIN_PRO (без 'ADMIN' — обычным админам не нужно).
 *
 * Параллельно поднимаем три набора данных через Promise.all, чтобы запросы
 * к БД шли разом, не последовательно (Decimal-поля сериализуются на стороне
 * query helper'а в `boris-briefings.ts`).
 */
export default async function BorisPage() {
  await requireRole(['ADMIN_PRO'])

  const [briefingsMorning, briefingsSelfAnalysis, metricsWeek] = await Promise.all([
    listRecentBriefings({ type: 'MORNING', limit: 30 }),
    listRecentBriefings({ type: 'SELF_ANALYSIS', limit: 30 }),
    getWeeklyMetricsSummary(),
  ])

  // Decimal → number конверсия для перехода server→client (Decimal не
  // сериализуется через props в Next App Router).
  const morningSerialized = briefingsMorning.map((b) => ({
    ...b,
    costUsd: Number(b.costUsd),
  }))
  const selfAnalysisSerialized = briefingsSelfAnalysis.map((b) => ({
    ...b,
    costUsd: Number(b.costUsd),
  }))

  return (
    <>
      <PageHeader
        title="Борис"
        subtitle="История брифингов и метрики Action-Бориса"
      />
      <BorisHistoryView
        briefingsMorning={morningSerialized}
        briefingsSelfAnalysis={selfAnalysisSerialized}
        metricsWeek={metricsWeek}
      />
    </>
  )
}
