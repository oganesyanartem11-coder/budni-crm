import { NextResponse } from 'next/server'
import { getReminder1530Text } from '@/lib/bot/templates'
import {
  sendRemindersToSilentClients,
  buildSummaryText,
  sendSummaryToManagers,
  alreadyRanToday,
  markRanToday,
} from '@/lib/bot/daily-summary'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'reminder-2' // 15:30 МСК

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET

  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  if (await alreadyRanToday(CRON_LABEL, now)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const reminders = await sendRemindersToSilentClients(getReminder1530Text, now)

  const summaryText = await buildSummaryText('Сводка по заявкам (15:30)', now)
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
