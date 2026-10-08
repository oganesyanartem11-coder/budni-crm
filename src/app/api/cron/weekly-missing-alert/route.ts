import { NextResponse } from 'next/server'
import { notifyAllAdminProDirect, escapeHtml } from '@/lib/telegram/notify'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'
import { findWeeklyClients, getNextWeek, hasNextWeekRequest, type NextWeek } from '@/lib/weekly/reminders'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CRON_LABEL = 'weekly-missing-alert' // Пт 15:00 МСК

/**
 * Алёрт менеджеру: заявки нет. Есть привязанный чат — клиенту напомнили в пт
 * 10:00 и 13:00; нет чата — напоминания не уходили (weekly-request-reminder
 * таких пропускает), и писать «напомнили» было бы неправдой.
 */
function buildAlertText(clientName: string, week: NextWeek, hasChat: boolean): string {
  const reminded = hasChat
    ? 'Напомнили в пятницу в 10:00 и 13:00 — без ответа.'
    : 'Напомнить не смогли — нет привязанного чата.'
  return `⚠️ ${escapeHtml(clientName)}: нет заявки на следующую неделю (${week.label}). ${reminded} Связаться лично?`
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
      const hasChat = (await getActiveMaxChatIdForClient(client.id)) !== null
      const text = buildAlertText(client.name, week, hasChat)
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
