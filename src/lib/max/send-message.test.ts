import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ send: vi.fn(), group: vi.fn(), receipts: new Map<string, unknown>(), failSentReceipt: false }))
vi.mock('./client', () => ({ getMaxBot: () => ({ api: { sendMessageToChat: mocks.send } }) }))
vi.mock('@/lib/db/prisma', () => ({ prisma: {
  clientMaxGroup: { findUnique: mocks.group },
  activityLog: {
    findUnique: async ({ where }: { where: { id: string } }) => mocks.receipts.get(where.id),
    upsert: async ({ where, create, update }: { where: { id: string }; create: object; update: object }) => {
      if (mocks.failSentReceipt && (update as { action?: string }).action === 'MAX_SCHEDULED_SENT') {
        mocks.failSentReceipt = false
        throw new Error('DB receipt write failed')
      }
      const row = mocks.receipts.has(where.id) ? { ...mocks.receipts.get(where.id) as object, ...update } : create
      mocks.receipts.set(where.id, row)
      return row
    },
    updateMany: async ({ where, data }: { where: { id: string }; data: { action: string } }) => {
      const row = mocks.receipts.get(where.id) as { action: string }
      if (!['MAX_SCHEDULED_PENDING', 'MAX_SCHEDULED_FAILED'].includes(row.action)) return { count: 0 }
      mocks.receipts.set(where.id, { ...row, ...data })
      return { count: 1 }
    },
  },
} }))
import { sendBotMessage } from './send-message'
beforeEach(() => { vi.resetAllMocks(); mocks.receipts.clear(); mocks.failSentReceipt = false; mocks.send.mockResolvedValue({}) })
describe('личка и группа', () => {
  it('сбой записи квитанции после отправки не повторяет доставленное сообщение', async () => {
    mocks.group.mockResolvedValue(null)
    mocks.failSentReceipt = true
    await expect(sendBotMessage('123', 'Вопрос', { delay: false, broadcastClientId: 'c1' })).rejects.toThrow()
    await expect(sendBotMessage('123', 'Вопрос', { delay: false, broadcastClientId: 'c1' })).rejects.toThrow()
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('одновременные рассылки не отправляют один вопрос дважды', async () => {
    mocks.group.mockResolvedValue(null)
    await Promise.allSettled([
      sendBotMessage('123', 'Вопрос', { delay: false, broadcastClientId: 'c1' }),
      sendBotMessage('123', 'Вопрос', { delay: false, broadcastClientId: 'c1' }),
    ])
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('вопрос приходит в оба чата', async () => {
    mocks.group.mockResolvedValue({ chatId: '-42', isActive: true })
    await sendBotMessage('123', 'Сколько?', { delay: false, broadcastClientId: 'c1' })
    expect(mocks.send.mock.calls).toEqual([[123, 'Сколько?'], [-42, 'Сколько?']])
  })
  it('ответ приходит только туда, откуда написали', async () => {
    await sendBotMessage('-42', 'Принято 8', { delay: false })
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(-42, 'Принято 8')
    expect(mocks.group).not.toHaveBeenCalled()
  })
  it('группа без лички не получает вопрос дважды', async () => {
    mocks.group.mockResolvedValue({ chatId: '-42', isActive: true })
    await sendBotMessage('-42', 'Сколько?', { delay: false, broadcastClientId: 'c1' })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('сбой лички не мешает попытке отправить в группу и виден cron', async () => {
    mocks.group.mockResolvedValue({ chatId: '-42', isActive: true })
    mocks.send.mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce({})
    await expect(sendBotMessage('123', 'Сколько?', { delay: false, broadcastClientId: 'c1' })).rejects.toThrow('1 из 2')
    expect(mocks.send).toHaveBeenCalledTimes(2)
    mocks.send.mockClear()
    await sendBotMessage('123', 'Сколько?', { delay: false, broadcastClientId: 'c1' })
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(123, 'Сколько?')
  })
})
