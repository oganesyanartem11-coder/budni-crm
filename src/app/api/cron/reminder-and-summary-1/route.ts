import { NextResponse } from 'next/server'
import { getReminder14Text } from '@/lib/bot/templates'
import {
  sendRemindersToSilentClients,
  buildSummaryText,
  sendSummaryToManagers,
  alreadyRanToday,
  markRanToday,
} from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'reminder-1' // 14:00 МСК

async function handler(_request: Request) {
  const now = new Date()

  if (await alreadyRanToday(CRON_LABEL, now)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const reminders = await sendRemindersToSilentClients(getReminder14Text, now)

  const summaryText = await buildSummaryText('Сводка по заявкам (14:00)', now)
  let summary = { sentToManagers: 0, errors: [] as Array<{ managerId: string; reason: string }> }
  if (summaryText) {
    summary = await sendSummaryToManagers(summaryText)
  }

  await markRanToday(CRON_LABEL, {
    sent_reminders: reminders.sent,
    sent_summaries_to_managers: summary.sentToManagers,
    skipped_reminders: reminders.skipped,
    summary_skipped: !summaryText,
  })

  return NextResponse.json({
    ok: true,
    sent_reminders: reminders.sent,
    skipped_reminders: reminders.skipped,
    sent_summaries_to_managers: summary.sentToManagers,
    summary_skipped: !summaryText,
    errors: [...reminders.errors, ...summary.errors],
  })
}

export const GET = withCronHeartbeat('reminder-and-summary-1', handler)
