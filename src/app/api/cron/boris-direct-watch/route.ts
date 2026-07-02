/**
 * Cron: Борис-Директ, лёгкий интрадей-надзор кампании (несколько раз в день,
 * БЕЗ суточной идемпотентности — это и есть смысл надзора).
 *
 * Проверки (только чтение campaigns.get):
 * - ADD_METRICA_TAG слетел в NO (ломается атрибуция заявок);
 * - State не ON / Status не ACCEPTED (кампания не крутится);
 * - StatusPayment не ALLOWED (показы заблокированы оплатой).
 *
 * Дедуп алёртов в течение дня: снапшоты 'watch_alert' за сегодня-МСК по kind —
 * один и тот же алёрт не спамим на каждом прогоне. Ошибка API Директа →
 * warn-сообщение в чат + ok:false в ответе (heartbeat зафиксирует).
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  getCampaignState,
  getAddMetricaTagValue,
  type CampaignState,
} from '@/lib/boris-direct/direct-client'
import { mskDay, mskDayStartUtc } from '@/lib/boris-direct/brain'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { formatAnomalyMessage } from '@/lib/boris-direct/report-texts'
import type { Anomaly } from '@/lib/boris-direct/anomalies'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-watch'

/** Детерминированные проверки состояния кампании → самодельные Anomaly. */
function detectWatchProblems(campaign: CampaignState): Anomaly[] {
  const problems: Anomaly[] = []
  if (getAddMetricaTagValue(campaign) === 'NO') {
    problems.push({
      severity: 'critical',
      kind: 'watch_metrica_tag_off',
      text: 'ADD_METRICA_TAG=NO: разметка ссылок Метрикой слетела — атрибуция заявок ломается, нужно вернуть YES.',
    })
  }
  if (campaign.State !== 'ON') {
    problems.push({
      severity: 'critical',
      kind: 'watch_state',
      text: `Кампания не крутится: State=${campaign.State} (жду ON) — показов нет.`,
    })
  }
  if (campaign.Status !== 'ACCEPTED') {
    problems.push({
      severity: 'critical',
      kind: 'watch_status',
      text: `Кампания не принята модерацией: Status=${campaign.Status} (жду ACCEPTED).`,
    })
  }
  if (campaign.StatusPayment !== 'ALLOWED') {
    problems.push({
      severity: 'critical',
      kind: 'watch_payment',
      text: `Показы заблокированы оплатой: StatusPayment=${campaign.StatusPayment} — проверить баланс.`,
    })
  }
  return problems
}

async function handler(_request: Request) {
  const now = new Date()

  let campaign: CampaignState
  try {
    campaign = await getCampaignState()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron:${JOB_LABEL}] API Директа недоступен`, err)
    await sendToDirectChat(
      '⚠️ Надзор Директа: API не отвечает, состояние кампании не проверил. Если повторится — смотреть доступы и квоты.'
    )
    return NextResponse.json({ ok: false, error: message })
  }

  const problems = detectWatchProblems(campaign)

  // Дедуп: kind, по которым сегодня-МСК уже улетал алёрт, молчат до завтра.
  const todayTick = mskDayStartUtc(mskDay(now))
  const sentToday = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'watch_alert', tickDate: todayTick },
    select: { payload: true },
  })
  const alreadyAlerted = new Set(
    sentToday.map((snap) => (snap.payload as unknown as { kind?: string })?.kind ?? '')
  )

  let alerted = 0
  for (const problem of problems) {
    if (alreadyAlerted.has(problem.kind)) continue
    await sendToDirectChat(formatAnomalyMessage(problem))
    await prisma.borisDirectSnapshot.create({
      data: {
        tickDate: todayTick,
        kind: 'watch_alert',
        payload: {
          kind: problem.kind,
          severity: problem.severity,
          text: problem.text,
        } as Prisma.InputJsonValue,
      },
    })
    alerted += 1
  }

  return NextResponse.json({
    ok: true,
    problems: problems.length,
    alerted,
    deduped: problems.length - alerted,
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
