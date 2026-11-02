import { prisma } from '@/lib/db/prisma'
import { randomUUID } from 'node:crypto'

export class MaxClientBusyError extends Error {}

/** Short atomic lease shared by group and private intake. Ten minutes exceeds
 * the webhook's 60-second lifetime. Never hold a DB transaction across LLM/MAX.
 * Deduplication is per message, so independent dates are never discarded.
 * An interrupted partial application is sent to review, never replayed as +N.
 */
export async function withMaxClientLock(
  clientId: string,
  message: { timestamp?: number; body?: { mid?: string } } | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const mid = message?.body?.mid
  if (!mid) throw new MaxClientBusyError('MAX: отсутствует идентификатор сообщения')
  const id = `${clientId}:${mid}`
  const token = randomUUID()
  let state: 'skip' | 'review' | 'run'
  try {
    state = await prisma.$transaction(async (tx) => {
      const receipt = await tx.maxInboundReceipt.upsert({ where: { id }, create: { id, clientId }, update: {} })
      if (receipt.status === 'DONE' || receipt.status === 'REVIEW') return 'skip'
      const claim = await tx.clientMaxGroup.updateMany({
        where: { clientId, isActive: true, OR: [{ processingToken: null }, { processingUntil: { lt: new Date() } }] },
        data: { processingToken: token, processingUntil: new Date(Date.now() + 10 * 60 * 1000) },
      })
      if (!claim.count) throw new MaxClientBusyError('Предыдущий ответ клиента ещё обрабатывается')
      const abandoned = await tx.maxInboundReceipt.updateMany({
        where: { clientId, id: { not: id }, status: 'PROCESSING' }, data: { status: 'REVIEW' },
      })
      if (abandoned.count || receipt.status === 'PROCESSING') await tx.inboxItem.create({ data: {
        clientId, priority: 'HIGH', reason: 'NON_NUMERIC', status: 'UNREAD',
        humanReason: 'Обработка сообщения MAX прервалась. Проверьте заказы перед повторным внесением: часть изменений могла сохраниться.',
        clientMessage: mid,
      } })
      await tx.maxInboundReceipt.update({ where: { id }, data: { status: receipt.status === 'PROCESSING' ? 'REVIEW' : 'PROCESSING' } })
      return receipt.status === 'PROCESSING' ? 'review' : 'run'
    })
  } catch (err) {
    if (err instanceof MaxClientBusyError) throw err
    throw new MaxClientBusyError('Не удалось начать обработку сообщения MAX')
  }
  if (state === 'skip') return
  let completed = false
  try {
    if (state === 'review') {
      return
    }
    await run()
    await prisma.maxInboundReceipt.update({ where: { id }, data: { status: 'DONE' } })
    completed = true
  } finally {
    await prisma.clientMaxGroup.updateMany({ where: { clientId, processingToken: token }, data: {
      processingToken: null, processingUntil: null,
      ...(completed ? { lastMessageAt: message?.timestamp ? new Date(message.timestamp) : new Date(), lastMessageId: mid } : {}),
    } })
  }
}
