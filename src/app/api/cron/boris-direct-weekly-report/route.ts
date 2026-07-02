/**
 * Cron: Борис-Директ, недельный отчёт владельцу (понедельник утром).
 *
 * Защита от кривого расписания как в boris-morning-briefing: не понедельник
 * МСК → skip. Данные — снапшоты 'daily_result' за последние 7 МСК-дней
 * (последняя запись на день побеждает) + траты LLM за период + счётчик
 * PENDING-предложений. Агрегирует код, LLM только пересказывает.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { mskDay, mskDayStartUtc, type DailyReportData } from '@/lib/boris-direct/brain'
import { getLlmSpendForPeriod } from '@/lib/boris-direct/llm'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { generateWeeklyReportText } from '@/lib/boris-direct/report-texts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-weekly-report'

const DAY_MS = 24 * 60 * 60 * 1000

/** МСК weekday (1..7, Пн=1, Вс=7). UTC+3 без учёта сезона (Москва без DST). */
function mskWeekday(now: Date): number {
  const m = new Date(now.getTime() + 3 * 3600_000)
  const d = m.getUTCDay()
  return d === 0 ? 7 : d
}

async function handler(request: Request) {
  const now = new Date()
  const force = new URL(request.url).searchParams.get('force') === 'true'

  // Только понедельник МСК (force — для ручных прогонов/смоуков).
  if (!force && mskWeekday(now) !== 1) {
    return NextResponse.json({ ok: true, skipped: 'not_monday' })
  }

  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // Последние 7 МСК-дней: [сегодня-7 .. сегодня).
  const to = mskDayStartUtc(mskDay(now))
  const from = new Date(to.getTime() - 7 * DAY_MS)

  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'daily_result', tickDate: { gte: from, lt: to } },
    orderBy: { createdAt: 'asc' },
  })

  // Последняя запись на день побеждает (process мог перезаписать force-прогоном).
  const byDay = new Map<string, DailyReportData>()
  for (const snap of snaps) {
    const payload = snap.payload as unknown as DailyReportData
    if (payload?.dateLabel) byDay.set(payload.dateLabel, payload)
  }
  const days = [...byDay.values()].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel))

  const llmSpend = await getLlmSpendForPeriod(from, to)
  const proposalsPending = await prisma.borisDirectProposal.count({
    where: { status: 'PENDING' },
  })

  const text = await generateWeeklyReportText(days, {
    llmSpendUsd: llmSpend.costUsd,
    llmCalls: llmSpend.calls,
    proposalsPending,
  })
  const sent = await sendToDirectChat(text)

  await markRanToday(JOB_LABEL, { days: days.length, sent: sent.ok })

  return NextResponse.json({ ok: true, days: days.length, sent: sent.ok })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
