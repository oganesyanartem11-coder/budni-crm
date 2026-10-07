import { NextResponse } from 'next/server'
import { notifyAllAdminProDirect, escapeHtml } from '@/lib/telegram/notify'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { findWeeklyClients, getNextWeek, hasNextWeekRequest, type NextWeek } from '@/lib/weekly/reminders'

export const dynamic = 'force-dynamic'

const CRON_LABEL = 'weekly-missing-alert' // Пт 15:00 МСК

/** Алёрт менеджеру: клиенту напомнили в пт 10:00 и 13:00, заявки нет. */
function buildAlertText(clientName: string, week: NextWeek): string {
  return `⚠️ ${escapeHtml(clientName)}: нет заявки на следующую неделю (${week.label}). Напомнили в пятницу в 10:00 и 13:00 — без ответа. Связаться лично?`
}

export async function handler(request: Request) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()

  if (!dryRun && (await alreadyRanToday(CRON_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const week = getNextWeek(now)

  const clients = await findWeeklyClients()

  let alerted = 0
  let skippedHasSubmission = 0
  const errors: Array<{ clientId: string; reason: string }> = []

  for (const client of clients) {
    if (await hasNextWeekRequest(client, week)) {
      skippedHasSubmission++
      continue
    }
    if (dryRun) {
      alerted++
      continue
    }
    try {
      const text = buildAlertText(client.name, week)
      await notifyAllAdminProDirect(text)
      console.log(`[weekly-missing-alert] alerted manager for client=${client.id}`)
      alerted++
    } catch (err) {
      errors.push({
        clientId: client.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!dryRun) {
    await markRanToday(CRON_LABEL, {
      alerted,
      skippedHasSubmission,
      errors: errors.length,
    })
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    weekStartDate: week.mondayDay.toISOString(),
    alerted,
    skippedHasSubmission,
    errors,
  })
}

export const GET = withCronHeartbeat('weekly-missing-alert', handler)
