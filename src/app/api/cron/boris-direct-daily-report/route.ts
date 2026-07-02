/**
 * Cron: Борис-Директ, дневной отчёт владельцу (вечером, после тика «обработка»).
 *
 * Читает последний снапшот 'daily_result' за вчера-МСК (его пишет process),
 * собирает DailyReportInput и шлёт текст в чат Директа. Нет снапшота —
 * честное сообщение «данные не дозрели» БЕЗ markRanToday: повторный прогон
 * в тот же день догонит, когда process дожмёт отчёты.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { yesterdayMsk, mskDayStartUtc, type DailyReportData } from '@/lib/boris-direct/brain'
import { getDirectRoleState } from '@/lib/boris-direct/state'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import {
  generateDailyReportText,
  type DailyReportInput,
} from '@/lib/boris-direct/report-texts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-daily-report'

/** payload снапшота 'daily_result': DailyReportData + сводки процессинга. */
type DailyResultPayload = DailyReportData & {
  appliedSummaries?: string[]
  wouldDoSummaries?: string[]
  proposalsCreated?: string[]
}

async function handler(request: Request) {
  const now = new Date()
  const force = new URL(request.url).searchParams.get('force') === 'true'

  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  const { dateFrom: yesterday } = yesterdayMsk(now)
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind: 'daily_result', tickDate: mskDayStartUtc(yesterday) },
    orderBy: { createdAt: 'desc' },
  })

  if (!snap) {
    // Не падаем и не маркируем: process ещё может дожать отчёты сегодня.
    await sendToDirectChat(
      '📊 Дневной отчёт: данные за вчера ещё не готовы (отчёт Директа не дозрел). Догоню, как появятся.'
    )
    return NextResponse.json({ ok: true, skipped: 'no_snapshot', date: yesterday })
  }

  const payload = snap.payload as unknown as DailyResultPayload
  const state = await getDirectRoleState()

  const input: DailyReportInput = {
    data: {
      dateLabel: payload.dateLabel ?? yesterday,
      spendRub: payload.spendRub ?? null,
      clicks: payload.clicks ?? null,
      impressions: payload.impressions ?? null,
      ctr: payload.ctr ?? null,
      leadsTotal: payload.leadsTotal ?? 0,
      leadsFromDirect: payload.leadsFromDirect ?? 0,
      costPerLeadRub: payload.costPerLeadRub ?? null,
      topQueries: payload.topQueries ?? [],
      quarantine: payload.quarantine ?? false,
    },
    appliedSummaries: payload.appliedSummaries ?? [],
    wouldDoSummaries: payload.wouldDoSummaries ?? [],
    proposalsCreated: payload.proposalsCreated ?? [],
    // Аномалии уже ушли немедленно из collect/process — в отчёте не дублируем.
    anomalies: [],
    observe: state.mode === 'OBSERVE',
  }

  const text = await generateDailyReportText(input)
  const sent = await sendToDirectChat(text)

  await markRanToday(JOB_LABEL, { date: yesterday, sent: sent.ok })

  return NextResponse.json({ ok: true, date: yesterday, sent: sent.ok })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
