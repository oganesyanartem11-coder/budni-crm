import { NextResponse } from 'next/server'
import { sendBotMessage } from '@/lib/max/send-message'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getActiveMaxChatIdForClient } from '@/lib/bot/max-users'
import { logBotMessage } from '@/lib/bot/log-message'
import {
  findWeeklyClients,
  getNextWeek,
  hasNextWeekRequest,
  weeklyReminderText,
  type ReminderSlot,
} from '@/lib/weekly/reminders'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Пт 10:00 и 13:00 МСК (vercel.json «0 7,10 * * 5»). До 07.10 — один раз в чт
// 12:00; клиенты, отправляющие заявку на неделю, ответа часто не давали.
const CRON_LABEL = 'weekly-request-reminder'
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** Слот по МСК-часу запуска (до полудня — утренний); ?slot= — ручной запуск. */
function resolveSlot(url: URL, now: Date): ReminderSlot {
  const forced = url.searchParams.get('slot')
  if (forced === 'morning' || forced === 'afternoon') return forced
  const mskHour = new Date(now.getTime() + MSK_OFFSET_MS).getUTCHours()
  return mskHour < 12 ? 'morning' : 'afternoon'
}

export async function handler(request: Request) {
  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === 'true'

  const now = new Date()
  const slot = resolveSlot(url, now)
  // Отдельная метка на слот: второе напоминание в тот же день не должно
  // считаться «уже запускался сегодня».
  const label = `${CRON_LABEL}:${slot}`

  if (!dryRun && (await alreadyRanToday(label, now))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today', slot })
  }

  const week = getNextWeek(now)
  const text = weeklyReminderText(slot, week)
  const clients = await findWeeklyClients()

  let sent = 0
  let skippedHasSubmission = 0
  let skippedNoChat = 0
  const errors: Array<{ clientId: string; reason: string }> = []
  // Поимённо: «sent 2, skippedNoChat 1» не отвечало на вопрос, кому именно
  // напоминание не ушло (09.10 ИНПАРТ).
  const sentNames: string[] = []
  const noChatNames: string[] = []
  const hasRequestNames: string[] = []

  for (const client of clients) {
    if (await hasNextWeekRequest(client, week)) {
      skippedHasSubmission++
      hasRequestNames.push(client.name)
      continue
    }
    const chatId = await getActiveMaxChatIdForClient(client.id)
    if (!chatId) {
      skippedNoChat++
      noChatNames.push(client.name)
      continue
    }
    if (dryRun) {
      sent++
      sentNames.push(client.name)
      continue
    }
    try {
      // delay:false, как у остальных рассылок по расписанию: 15–30 с на клиента
      // подряд упирались в лимит функции, и хвост списка оставался без напоминания.
      await sendBotMessage(chatId, text, { delay: false })
      console.log(`[weekly-reminder] ${slot} sent to client=${client.id}`)
      sent++
      sentNames.push(client.name)
      // В переписку CRM: иначе менеджер не видит, что бот клиенту писал.
      await logBotMessage({ clientId: client.id, conversationId: null, direction: 'OUT', text }).catch((e) =>
        console.error('[weekly-reminder] log failed', e),
      )
    } catch (err) {
      errors.push({
        clientId: client.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!dryRun) {
    await markRanToday(label, {
      slot,
      sent,
      skippedHasSubmission,
      skippedNoChat,
      errors: errors.length,
      sentNames,
      noChatNames,
      hasRequestNames,
    })
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    slot,
    weekStartDate: week.mondayDay.toISOString(),
    sent,
    skippedHasSubmission,
    skippedNoChat,
    sentNames,
    noChatNames,
    hasRequestNames,
    errors,
  })
}

export const GET = withCronHeartbeat('weekly-request-reminder', handler)
