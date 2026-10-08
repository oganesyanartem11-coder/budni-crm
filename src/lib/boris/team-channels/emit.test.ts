import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Командный пост: HTML-санитайз + один повтор плоским текстом при отказе Telegram. */

const { mockNotifyGroup, mockSendTelegram } = vi.hoisted(() => ({
  mockNotifyGroup: vi.fn(),
  mockSendTelegram: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/telegram/notify', () => ({ notifyGroup: mockNotifyGroup }))
vi.mock('@/lib/telegram/send', () => ({ sendTelegramMessage: mockSendTelegram }))
vi.mock('@/lib/telegram/env', () => ({ getTelegramEnv: () => ({ groupChatId: '-100' }) }))
vi.mock('@/lib/boris/metrics/track', () => ({ trackBorisCall: vi.fn() }))
vi.mock('./context-builder', () => ({ buildDayContext: vi.fn() }))
vi.mock('@/lib/llm/client', () => ({ getAnthropicClient: vi.fn() }))
vi.mock('@/lib/ai/models', () => ({ getBorisModel: () => 'test-model' }))

import { sendTeamPost } from './emit'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendTeamPost', () => {
  it('шлёт санитайзенный HTML', async () => {
    mockNotifyGroup.mockResolvedValue({ ok: true })
    const r = await sendTeamPost('<b>Итог</b> <5 порций<br>', '-100', 'LIVE')
    expect(r).toEqual({ ok: true })
    expect(mockNotifyGroup).toHaveBeenCalledWith('<b>Итог</b> &lt;5 порций&lt;br&gt;', { parseMode: 'HTML' })
    expect(mockSendTelegram).not.toHaveBeenCalled()
  })

  it('Telegram отверг HTML → один повтор плоским текстом без parse_mode', async () => {
    mockNotifyGroup.mockResolvedValue({ ok: false, error: "Bad Request: can't parse entities" })
    mockSendTelegram.mockResolvedValue({ ok: true })
    const r = await sendTeamPost('<b>Итог</b> & всё', '-100', 'ALERT')
    expect(r).toEqual({ ok: true })
    expect(mockSendTelegram).toHaveBeenCalledTimes(1)
    expect(mockSendTelegram).toHaveBeenCalledWith('-100', 'Итог & всё')
  })

  it('notifyGroup кинул и plain не прошёл → ok:false с обеими ошибками', async () => {
    mockNotifyGroup.mockRejectedValue(new Error('boom'))
    mockSendTelegram.mockResolvedValue({ ok: false, error: 'forbidden' })
    const r = await sendTeamPost('x', '-100', 'LIVE')
    expect(r).toEqual({ ok: false, error: 'boom; plain: forbidden' })
  })
})
