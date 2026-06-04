import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * expire-pending-changes cron: помечает протухшие PENDING-запросы EXPIRED и
 * шлёт клиентам автоответ. Мокаем expirePendingChanges (бизнес-логика) и
 * sendBotMessage. Дёргаем handler напрямую (минуя withCronHeartbeat auth).
 */

const { mockExpire, mockSendBotMessage } = vi.hoisted(() => ({
  mockExpire: vi.fn(),
  mockSendBotMessage: vi.fn(),
}))

vi.mock('@/lib/order-changes/actions', () => ({ expirePendingChanges: mockExpire }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBotMessage }))

import { handler } from './route'

const REQ = new Request('http://x/api/cron/expire-pending-changes')

beforeEach(() => {
  vi.clearAllMocks()
  mockSendBotMessage.mockResolvedValue(undefined)
})

describe('expire-pending-changes', () => {
  it('2 протухших → 2 вызова sendBotMessage, ok=true sent=2', async () => {
    mockExpire.mockResolvedValue({
      expired: [
        { id: 'e1', clientMaxChatId: '111', postCutoffReplyText: 'reply1' },
        { id: 'e2', clientMaxChatId: '222', postCutoffReplyText: 'reply2' },
      ],
    })

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockSendBotMessage).toHaveBeenCalledTimes(2)
    expect(mockSendBotMessage).toHaveBeenCalledWith('111', 'reply1', { delay: false })
    expect(mockSendBotMessage).toHaveBeenCalledWith('222', 'reply2', { delay: false })
    expect(body).toEqual({ ok: true, expired: 2, sent: 2, failed: 0 })
  })

  it('sendBotMessage кидает → failed++, handler не падает', async () => {
    mockExpire.mockResolvedValue({
      expired: [
        { id: 'e1', clientMaxChatId: '111', postCutoffReplyText: 'reply1' },
        { id: 'e2', clientMaxChatId: '222', postCutoffReplyText: 'reply2' },
      ],
    })
    mockSendBotMessage
      .mockRejectedValueOnce(new Error('max down'))
      .mockResolvedValueOnce(undefined)

    const res = await handler(REQ)
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.expired).toBe(2)
    expect(body.sent).toBe(1)
    expect(body.failed).toBe(1)
  })

  it('нет протухших → sendBotMessage не вызывается', async () => {
    mockExpire.mockResolvedValue({ expired: [] })

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body).toEqual({ ok: true, expired: 0, sent: 0, failed: 0 })
  })
})
