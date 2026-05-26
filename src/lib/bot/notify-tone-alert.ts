import { prisma } from '@/lib/db/prisma'
import { notifyToneRecipients, escapeHtml } from '@/lib/telegram/notify'
import { getTelegramEnv } from '@/lib/telegram/env'
import { TONE_CONFIG, shouldBypassCooldown } from '@/lib/inbox/tone-labels'

const COOLDOWN_MIN = 15

/**
 * Шлёт tone-алёрт получателям из notifyToneRecipients
 * (MANAGER ∪ User.receivesToneAlerts=true) c Telegram-онбордингом.
 *
 * Cooldown:
 *   - rude   → 15 мин на пару (clientId, tone) через ToneAlertLog
 *   - urgent → bypass (см. shouldBypassCooldown) — срочные сигналы пробиваются
 *
 * Запись в ToneAlertLog делаем ПОСЛЕ broadcast — даже при sentTo=0 фиксируем
 * попытку, чтобы следующий cooldown-чек уважал интервал.
 *
 * Безопасно для параллельных вызовов: notifyAllManagersDirect не падает на
 * отдельных ошибках отправки (см. там Promise.allSettled).
 */
export async function notifyToneAlert(input: {
  clientId: string
  conversationId: string | null
  tone: 'rude' | 'urgent'
  messageText: string
}): Promise<void> {
  const { clientId, tone, messageText } = input
  console.log(`[bot] tone-alert START: client=${clientId} tone=${tone}`)

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true },
  })
  if (!client) {
    console.warn(`[bot] tone-alert: client not found ${clientId}`)
    return
  }

  if (!shouldBypassCooldown(tone)) {
    const cutoff = new Date(Date.now() - COOLDOWN_MIN * 60_000)
    const recent = await prisma.toneAlertLog.findFirst({
      where: { clientId, tone, createdAt: { gte: cutoff } },
      select: { id: true },
    })
    if (recent) {
      console.log(`[bot] tone-alert SKIPPED (cooldown): client=${clientId} tone=${tone}`)
      return
    }
  }

  const cfg = TONE_CONFIG[tone]
  const preview = messageText.length > 200 ? messageText.slice(0, 197) + '…' : messageText
  const { appBaseUrl } = getTelegramEnv()
  const link = `${appBaseUrl}/inbox/${clientId}`

  const text = [
    `${cfg.emoji} <b>${cfg.ru}</b>: ${escapeHtml(client.name)}`,
    ``,
    `<i>${escapeHtml(preview)}</i>`,
    ``,
    `<a href="${link}">Открыть диалог</a>`,
  ].join('\n')

  const result = await notifyToneRecipients(text, { parseMode: 'HTML' })

  await prisma.toneAlertLog.create({
    data: { clientId, tone },
  })

  console.log(
    `[bot] tone-alert DONE: client=${clientId} tone=${tone} ` +
      `sentTo=${result.sentTo} skippedNoTelegram=${result.skippedNoTelegram} failed=${result.failed}`
  )
}
