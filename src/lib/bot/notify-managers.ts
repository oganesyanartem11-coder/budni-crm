import { prisma } from '@/lib/db/prisma'
import { notifyAllManagersDirect, escapeHtml } from '@/lib/telegram/notify'
import { inboxListButton } from '@/lib/telegram/buttons'
import { getTelegramEnv } from '@/lib/telegram/env'
import type { InboxItemReason } from '@prisma/client'

const COOLDOWN_MINUTES = 15

const REASON_RU: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Сильное отклонение от обычного',
  ANOMALY_THRESHOLD: 'Цифра вне нормы',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен в парсинге',
  NON_NUMERIC: 'Не цифровой ответ',
  CANCELLATION_INTENT: 'Клиент хочет отменить',
  POST_CUTOFF: 'Сообщение после 16:00',
}

/**
 * Шлёт уведомление всем активным менеджерам (ADMIN+MANAGER) с привязанным
 * Telegram. Менеджеры, у которых не сделан Telegram-онбординг (нет
 * telegramChatId), пропускаются — в MAX не уходим (см. 5.8c).
 *
 * Если по этому inbox-item уже пушили <COOLDOWN_MINUTES минут назад —
 * пропускает. Cooldown канал-агностичен, оставляем как есть.
 *
 * Безопасно для параллельных вызовов: ошибка отправки одному менеджеру
 * не падает на остальных (см. notifyAllManagersDirect).
 */
export async function notifyManagersAboutInboxItem(inboxItemId: string): Promise<void> {
  console.log(`[bot] notifyManagers START: inbox=${inboxItemId}`)
  const item = await prisma.inboxItem.findUnique({
    where: { id: inboxItemId },
    include: { client: { select: { id: true, name: true } } },
  })
  if (!item) return

  if (item.lastPushedAt) {
    const elapsedMs = Date.now() - item.lastPushedAt.getTime()
    if (elapsedMs < COOLDOWN_MINUTES * 60 * 1000) {
      console.log(`[bot] notify skipped: cooldown active for inbox=${inboxItemId}`)
      return
    }
  }

  const reasonRu = REASON_RU[item.reason] ?? item.reason
  const messagePreview = item.clientMessage
    ? `\n\nСообщение: «${escapeHtml(item.clientMessage.slice(0, 200))}${
        item.clientMessage.length > 200 ? '…' : ''
      }»`
    : ''

  const { appBaseUrl } = getTelegramEnv()
  const link = `${appBaseUrl}/inbox/${item.id}`
  const priorityPrefix = item.priority === 'HIGH' ? '🔴 ' : '🔔 '

  const text =
    `${priorityPrefix}<b>Новое в Inbox</b>\n\n` +
    `Клиент: ${escapeHtml(item.client.name)}\n` +
    `Причина: ${reasonRu}${messagePreview}\n\n` +
    `Открыть: ${link}`

  const result = await notifyAllManagersDirect(text, {
    parseMode: 'HTML',
    replyMarkup: inboxListButton(),
  })

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: { lastPushedAt: new Date() },
  })

  console.log(
    `[bot] notifyManagers DONE: inbox=${inboxItemId} sentTo=${result.sentTo} ` +
      `skippedNoTelegram=${result.skippedNoTelegram} failed=${result.failed}`
  )
}
