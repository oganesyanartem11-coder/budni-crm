import { getMaxBot } from './client'
import { prisma } from '@/lib/db/prisma'
import { createHash } from 'node:crypto'
import { toMskDateString } from '@/lib/utils/msk-window'
import { maxGroupContext } from './group-context'

/** Случайная задержка 15-30 сек для естественности ответа клиенту. */
function randomClientDelayMs(): number {
  return 15000 + Math.floor(Math.random() * 15000)
}

export interface SendBotMessageOptions {
  /**
   * По умолчанию true: перед отправкой ждём 15-30 сек, чтобы клиент в MAX
   * не видел мгновенный ответ бота. Cron-маршруты (daily-questions,
   * cutoff-notice, reminder-and-summary-1/2) передают false — там получателей
   * много, общая длительность превысила бы лимит Vercel-функции, а для
   * scheduled-рассылок ощущение «живой переписки» не нужно.
   */
  delay?: boolean
  /** Плановый вопрос/напоминание: личный чат и привязанная группа. */
  broadcastClientId?: string
}

/**
 * Отправляет текст в персональный чат MAX (от лица бота).
 * Использует bot.api.sendMessageToChat — см. dist/api.d.ts SDK.
 */
export async function sendBotMessage(
  maxChatId: string,
  text: string,
  options: SendBotMessageOptions = {}
): Promise<void> {
  const chatIdNum = Number(maxChatId)
  if (Number.isNaN(chatIdNum)) {
    throw new Error(`invalid maxChatId: ${maxChatId}`)
  }
  const delay = options.delay ?? !maxGroupContext.getStore()
  if (delay) {
    await new Promise((resolve) => setTimeout(resolve, randomClientDelayMs()))
  }
  const bot = getMaxBot()
  const recipients = new Set([maxChatId])
  if (options.broadcastClientId) {
    const group = await prisma.clientMaxGroup.findUnique({ where: { clientId: options.broadcastClientId } })
    if (group?.isActive && group.chatId) recipients.add(group.chatId)
  }
  const results = await Promise.allSettled([...recipients].map(async (id) => {
    // Per-recipient receipt: retrying a partial broadcast never repeats the
    // question in the destination that already received it. The scheduled
    // morning/afternoon reminders have different texts.
    const receiptId = options.broadcastClientId
      ? `max-send:${createHash('sha256').update(`${options.broadcastClientId}:${id}:${toMskDateString(new Date())}:${text}`).digest('hex')}`
      : null
    if (receiptId) {
      const receipt = await prisma.activityLog.upsert({
        where: { id: receiptId },
        create: { id: receiptId, action: 'MAX_SCHEDULED_PENDING', entityType: 'Client', entityId: options.broadcastClientId, payload: { chatId: id } },
        update: {},
      })
      if (receipt?.action === 'MAX_SCHEDULED_SENT') return
      const claimed = await prisma.activityLog.updateMany({
        where: { id: receiptId, OR: [
          { action: { in: ['MAX_SCHEDULED_PENDING', 'MAX_SCHEDULED_FAILED'] } },
        ] },
        data: { action: 'MAX_SCHEDULED_SENDING', payload: { chatId: id, sendingUntil: Date.now() + 10 * 60 * 1000 } },
      })
      if (!claimed.count) throw new Error('MAX: отправка этому адресату уже выполняется')
    }
    let delivered = false
    try {
      await bot.api.sendMessageToChat(Number(id), text)
      delivered = true
      if (receiptId) await prisma.activityLog.upsert({
        where: { id: receiptId },
        create: { id: receiptId, action: 'MAX_SCHEDULED_SENT', entityType: 'Client', entityId: options.broadcastClientId, payload: { chatId: id } },
        update: { action: 'MAX_SCHEDULED_SENT', payload: { chatId: id } },
      })
    } catch (err) {
      console.error('[MAX] scheduled recipient failed', { chatId: id, clientId: options.broadcastClientId })
      if (receiptId) await prisma.activityLog.upsert({
        where: { id: receiptId },
        create: { id: receiptId, action: delivered ? 'MAX_SCHEDULED_UNCERTAIN' : 'MAX_SCHEDULED_FAILED', entityType: 'Client', entityId: options.broadcastClientId, payload: { chatId: id } },
        update: { action: delivered ? 'MAX_SCHEDULED_UNCERTAIN' : 'MAX_SCHEDULED_FAILED', payload: { chatId: id } },
      }).catch(() => {})
      throw err
    }
  }))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length) throw new Error(`MAX: не удалось отправить сообщение ${failed.length} из ${recipients.size} адресатов`)
}
