import { beforeEach, describe, expect, it, vi } from 'vitest'
const tx = vi.hoisted(() => ({ clientMaxGroup: { updateMany: vi.fn() }, maxInboundReceipt: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, inboxItem: { create: vi.fn() } }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { ...tx, $transaction: (run: (tx: unknown) => unknown) => run(tx) } }))
import { MaxClientBusyError, withMaxClientLock } from './client-message-lock'
beforeEach(() => { vi.resetAllMocks(); tx.maxInboundReceipt.upsert.mockResolvedValue({ status: 'RECEIVED' }); tx.maxInboundReceipt.updateMany.mockResolvedValue({ count: 0 }); tx.clientMaxGroup.updateMany.mockResolvedValue({ count: 1 }) })
describe('порядок ответов', () => {
  it('более старый ответ о другой дате не теряется', async () => {
    const run = vi.fn()
    await withMaxClientLock('c1', { timestamp: 1000, body: { mid: 'old' } }, run)
    expect(run).toHaveBeenCalledOnce()
  })
  it('повтор одного сообщения не применяет +1 второй раз', async () => {
    tx.maxInboundReceipt.upsert.mockResolvedValue({ status: 'DONE' })
    const run = vi.fn()
    await withMaxClientLock('c1', { timestamp: 2000, body: { mid: 'same' } }, run)
    expect(run).not.toHaveBeenCalled()
  })
  it('после обработки сохраняет квитанцию по id сообщения', async () => {
    const run = vi.fn()
    await withMaxClientLock('c1', { timestamp: 2000, body: { mid: 'new' } }, run)
    expect(run).toHaveBeenCalledOnce()
    expect(tx.maxInboundReceipt.update).toHaveBeenLastCalledWith({ where: { id: 'c1:new' }, data: { status: 'DONE' } })
  })
  it('при занятой блокировке просит повтор webhook и не пишет заказ', async () => {
    tx.clientMaxGroup.updateMany.mockResolvedValue({ count: 0 })
    const run = vi.fn()
    await expect(withMaxClientLock('c1', { timestamp: 2000, body: { mid: 'busy' } }, run)).rejects.toBeInstanceOf(MaxClientBusyError)
    expect(run).not.toHaveBeenCalled()
  })
  it('прерванное применение отдаёт менеджеру, не повторяет +N', async () => {
    tx.maxInboundReceipt.upsert.mockResolvedValue({ status: 'PROCESSING' })
    const run = vi.fn()
    await withMaxClientLock('c1', { body: { mid: 'partial' } }, run)
    expect(run).not.toHaveBeenCalled()
    expect(tx.inboxItem.create).toHaveBeenCalledWith({ data: expect.objectContaining({ clientId: 'c1', priority: 'HIGH' }) })
  })
})
