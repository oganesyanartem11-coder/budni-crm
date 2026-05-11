import { prisma } from '@/lib/db/prisma'
import { sendBotMessage } from '@/lib/max/send-message'
import type { InboxItemReason } from '@prisma/client'

const COOLDOWN_MINUTES = 15

const REASON_RU: Record<InboxItemReason, string> = {
  NEW_CLIENT: 'Новый клиент',
  ANOMALY_HISTORICAL: 'Сильное отклонение от обычного',
  ANOMALY_THRESHOLD: 'Цифра вне нормы',
  ANOMALY_LLM_CONFIDENCE: 'LLM не уверен в парсинге',
  NON_NUMERIC: 'Не цифровой ответ',
  CANCELLATION_INTENT: 'Клиент хочет отменить',
  POST_CUTOFF: 'Сообщение после 18:00',
}

/**
 * Шлёт уведомление всем менеджерам (MANAGER+ADMIN) с привязанным maxChatId.
 * Если по этому inbox-item уже пушили <COOLDOWN_MINUTES минут назад — пропускает.
 * Безопасно для параллельных вызовов: ошибка отправки одному менеджеру не падает на остальных.
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

  const managers = await prisma.user.findMany({
    where: {
      role: { in: ['MANAGER', 'ADMIN'] },
      maxChatId: { not: null },
      isActive: true,
    },
    select: { id: true, maxChatId: true },
  })

  if (managers.length === 0) {
    console.warn('[bot] notify: no managers with maxChatId — skipping push')
    return
  }

  const reasonRu = REASON_RU[item.reason] ?? item.reason
  const messagePreview = item.clientMessage
    ? `\n\nСообщение: «${item.clientMessage.slice(0, 200)}${item.clientMessage.length > 200 ? '…' : ''}»`
    : ''

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://budni-crm.vercel.app'
  const link = `${baseUrl}/inbox/${item.id}`
  const priorityPrefix = item.priority === 'HIGH' ? '🔴 ' : '🔔 '
  const text = `${priorityPrefix}Новое в Inbox

Клиент: ${item.client.name}
Причина: ${reasonRu}${messagePreview}

Открыть: ${link}`

  await Promise.all(
    managers.map(async (m) => {
      if (!m.maxChatId) return
      try {
        await sendBotMessage(m.maxChatId, text)
      } catch (e) {
        console.error(`[bot] failed to push manager ${m.id}:`, (e as Error).message)
      }
    })
  )

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: { lastPushedAt: new Date() },
  })

  console.log(`[bot] notifyManagers DONE: inbox=${inboxItemId}, recipients=${managers.length}`)
}
