/**
 * Cron: Борис-Директ, месячный отчёт владельцу (1-го числа МСК).
 *
 * Не 1-е число МСК → skip (защита от кривого расписания). Данные —
 * снапшоты 'daily_result' за ПРОШЛЫЙ календарный месяц (МСК) + траты LLM
 * за тот же месяц. Итог и динамику цены заявки по неделям считает код,
 * LLM пересказывает; строка про деньги на аналитику добавляется кодом
 * внутри generateMonthlyReportText.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { mskDay, mskDayStartUtc, type DailyReportData } from '@/lib/boris-direct/brain'
import { getLlmSpendForPeriod } from '@/lib/boris-direct/llm'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { generateMonthlyReportText } from '@/lib/boris-direct/report-texts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-monthly-report'

/** Русские названия месяцев для monthLabel («июнь 2026»). */
const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
]

async function handler(request: Request) {
  const now = new Date()
  const force = new URL(request.url).searchParams.get('force') === 'true'

  const today = mskDay(now) // 'YYYY-MM-DD'

  // Только 1-е число МСК (force — для ручных прогонов/смоуков).
  if (!force && !today.endsWith('-01')) {
    return NextResponse.json({ ok: true, skipped: 'not_first_day' })
  }

  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // Прошлый календарный месяц (МСК): [1-е прошлого .. 1-е текущего).
  const [year, month] = today.split('-').map(Number)
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  const from = mskDayStartUtc(`${prevYear}-${String(prevMonth).padStart(2, '0')}-01`)
  const to = mskDayStartUtc(`${year}-${String(month).padStart(2, '0')}-01`)
  const monthLabel = `${MONTH_NAMES[prevMonth - 1]} ${prevYear}`

  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'daily_result', tickDate: { gte: from, lt: to } },
    orderBy: { createdAt: 'asc' },
  })

  // Последняя запись на день побеждает.
  const byDay = new Map<string, DailyReportData>()
  for (const snap of snaps) {
    const payload = snap.payload as unknown as DailyReportData
    if (payload?.dateLabel) byDay.set(payload.dateLabel, payload)
  }
  const days = [...byDay.values()].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel))

  const llmSpend = await getLlmSpendForPeriod(from, to)

  const text = await generateMonthlyReportText(days, {
    llmSpendUsd: llmSpend.costUsd,
    llmCalls: llmSpend.calls,
    monthLabel,
  })
  const sent = await sendToDirectChat(text)

  await markRanToday(JOB_LABEL, { month: monthLabel, days: days.length, sent: sent.ok })

  return NextResponse.json({ ok: true, month: monthLabel, days: days.length, sent: sent.ok })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
