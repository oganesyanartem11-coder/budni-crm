import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindMany, mockReadProductionChatId, mockSend } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockReadProductionChatId: vi.fn(),
  mockSend: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: { user: { findMany: mockFindMany } },
}))
vi.mock('./send', () => ({ sendTelegramMessage: mockSend }))
vi.mock('./env', () => ({
  getTelegramEnv: vi.fn(),
  readProductionChatId: mockReadProductionChatId,
  readLeadsChatId: vi.fn(),
}))

import { notifyProductionChannel } from './notify'

beforeEach(() => {
  vi.clearAllMocks()
  mockReadProductionChatId.mockReturnValue('-100production')
  mockFindMany.mockResolvedValue([])
  mockSend.mockResolvedValue({ ok: true })
})

describe('notifyProductionChannel delivery result', () => {
  it('подтверждает доставку в production chat', async () => {
    await expect(notifyProductionChannel('test', { parseMode: 'HTML' })).resolves.toEqual({
      ok: true,
      destination: 'production',
    })
  })

  it('подтверждает успешный fallback хотя бы одному ADMIN_PRO', async () => {
    mockSend
      .mockResolvedValueOnce({ ok: false, error: 'telegram down' })
      .mockResolvedValueOnce({ ok: true })
    mockFindMany.mockResolvedValue([{ id: 'admin_1', telegramChatId: '123' }])

    await expect(notifyProductionChannel('test', { parseMode: 'HTML' })).resolves.toEqual({
      ok: true,
      destination: 'admin_pro',
    })
  })

  it('возвращает ok=false, если production и fallback никому не доставили', async () => {
    mockSend.mockResolvedValue({ ok: false, error: 'telegram down' })
    mockFindMany.mockResolvedValue([])

    const result = await notifyProductionChannel('test', { parseMode: 'HTML' })

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      destination: null,
    }))
    if (result.ok) throw new Error('expected failed delivery')
    expect(result.error).toContain('не доставлено')
  })
})
