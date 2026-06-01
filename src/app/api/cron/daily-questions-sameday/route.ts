import { NextResponse } from 'next/server'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import {
  runDailyQuestions,
  buildCandidatesWhere,
} from '@/lib/bot/daily-questions-core'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

/**
 * Same-day cron (40 4 * * * = 07:40 МСК). Спрашивает sameDay-клиентов про
 * доставку СЕГОДНЯ (у них утренний cut-off). Обычных клиентов берёт
 * daily-questions; здесь — только те, у кого есть sameDay-локация.
 */
async function handler(request: Request) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()
  const todayMsk = getMskCalendarDayUtc(now, 0)

  const result = await runDailyQuestions({
    label: 'daily-questions-sameday',
    todayMsk,
    targetMode: 'today-only',
    searchFrom: todayMsk,
    where: buildCandidatesWhere(true),
    dryRun,
  })

  return NextResponse.json({
    ok: true,
    dryRun,
    todayMsk: todayMsk.toISOString(),
    ...result,
  })
}

export const GET = withCronHeartbeat('daily-questions-sameday', handler)
