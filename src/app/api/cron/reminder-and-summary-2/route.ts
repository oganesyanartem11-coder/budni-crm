import { NextResponse } from 'next/server'
import { getReminder1530Text } from '@/lib/bot/templates'
import {
  sendRemindersToSilentClients,
  alreadyRanToday,
  markRanToday,
} from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'reminder-2' // 15:30 МСК

async function handler(_request: Request) {
  const now = new Date()

  if (await alreadyRanToday(CRON_LABEL, now)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // #1: автосводка менеджерам в 15:30 убрана (дублировала сводку 14:00 +
  // Артём принимает заявки вручную). Напоминания молчащим клиентам оставлены.
  const reminders = await sendRemindersToSilentClients(getReminder1530Text, now)

  await markRanToday(CRON_LABEL, {
    sent_reminders: reminders.sent,
    skipped_reminders: reminders.skipped,
  })

  return NextResponse.json({
    ok: true,
    sent_reminders: reminders.sent,
    skipped_reminders: reminders.skipped,
    errors: reminders.errors,
  })
}

export const GET = withCronHeartbeat('reminder-and-summary-2', handler)
