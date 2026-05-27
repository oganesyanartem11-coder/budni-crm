import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import {
  listRecentBriefings,
  listRecentBriefingsForChannels,
  listRecentBorisEvents,
  getWeeklyMetricsSummary,
  getTeamWeeklyMetrics,
} from '@/lib/db/queries/boris-briefings'
import { BorisHistoryView } from './_components/boris-history-view'

/**
 * /boris — admin-инспектор брифингов и метрик Action-Бориса.
 * Строго ADMIN_PRO (без 'ADMIN' — обычным админам не нужно).
 *
 * 7.16.C ЭТАП 2: добавлен таб «Команда» (Командный Борис) — feed постов,
 * журнал событий и метрики недели. Все 5 запросов идут параллельно через
 * Promise.all (Decimal-поля сериализуются ниже на границе server→client).
 */
export default async function BorisPage() {
  await requireRole(['ADMIN_PRO'])

  const [
    briefingsMorning,
    briefingsSelfAnalysis,
    metricsWeek,
    teamBriefingsRaw,
    teamEventsRaw,
    teamMetricsWeek,
  ] = await Promise.all([
    listRecentBriefings({ type: 'MORNING', limit: 30 }),
    listRecentBriefings({ type: 'SELF_ANALYSIS', limit: 30 }),
    getWeeklyMetricsSummary(),
    listRecentBriefingsForChannels({ limit: 30 }),
    // ADMIN_PRO видит весь журнал событий. Для не-PRO ролей страница недоступна
    // (см. requireRole выше) — фильтрация по роли на UI не нужна.
    listRecentBorisEvents({ limit: 50 }),
    getTeamWeeklyMetrics(),
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
  const teamBriefingsSerialized = teamBriefingsRaw.map((b) => ({
    ...b,
    costUsd: Number(b.costUsd),
  }))

  // teamEvents: payload (Json) уже plain, остальные поля сериализуемые.
  // Явно мапим, чтобы зафиксировать форму на границе.
  const teamEventsSerialized = teamEventsRaw.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    eventDate: e.eventDate,
    clientId: e.clientId,
    client: e.client,
    orderId: e.orderId,
    order: e.order,
    menuCycleId: e.menuCycleId,
    menuCycle: e.menuCycle,
    payload: e.payload,
    deduplKey: e.deduplKey,
    emittedTo: e.emittedTo,
    emittedAt: e.emittedAt,
    createdAt: e.createdAt,
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
        teamBriefings={teamBriefingsSerialized}
        teamEvents={teamEventsSerialized}
        teamMetricsWeek={teamMetricsWeek}
      />
    </>
  )
}
