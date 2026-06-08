import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Boris reorg (волна 2): персист последнего группового ответа Бори.
 * Обе функции best-effort — на ошибке БД не бросают (окно не должно ронять ответ).
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    borisGroupReplyTracker: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  getLastBorisGroupReply,
  getLastBorisGroupReplyMessageId,
  recordBorisGroupReply,
} from './group-reply-tracker'

beforeEach(() => {
  mockPrisma.borisGroupReplyTracker.findUnique.mockReset()
  mockPrisma.borisGroupReplyTracker.upsert.mockReset()
})

describe('getLastBorisGroupReplyMessageId', () => {
  it('есть запись → возвращает lastReplyMessageId', async () => {
    mockPrisma.borisGroupReplyTracker.findUnique.mockResolvedValue({ lastReplyMessageId: 4242 })
    expect(await getLastBorisGroupReplyMessageId('-100123')).toBe(4242)
    expect(mockPrisma.borisGroupReplyTracker.findUnique).toHaveBeenCalledWith({
      where: { tgChatId: '-100123' },
      select: { lastReplyMessageId: true, updatedAt: true },
    })
  })

  it('нет записи → null', async () => {
    mockPrisma.borisGroupReplyTracker.findUnique.mockResolvedValue(null)
    expect(await getLastBorisGroupReplyMessageId('-100123')).toBeNull()
  })

  it('пустой chatId → null без запроса', async () => {
    expect(await getLastBorisGroupReplyMessageId('')).toBeNull()
    expect(mockPrisma.borisGroupReplyTracker.findUnique).not.toHaveBeenCalled()
  })

  it('ошибка БД → null (fail-safe, не бросает)', async () => {
    mockPrisma.borisGroupReplyTracker.findUnique.mockRejectedValue(new Error('P1001'))
    expect(await getLastBorisGroupReplyMessageId('-100123')).toBeNull()
  })
})

describe('getLastBorisGroupReply', () => {
  it('есть запись → возвращает { messageId, updatedAt }', async () => {
    const updatedAt = new Date('2026-06-08T10:00:00.000Z')
    mockPrisma.borisGroupReplyTracker.findUnique.mockResolvedValue({
      lastReplyMessageId: 4242,
      updatedAt,
    })
    expect(await getLastBorisGroupReply('-100123')).toEqual({
      messageId: 4242,
      updatedAt,
    })
    expect(mockPrisma.borisGroupReplyTracker.findUnique).toHaveBeenCalledWith({
      where: { tgChatId: '-100123' },
      select: { lastReplyMessageId: true, updatedAt: true },
    })
  })

  it('нет записи → null', async () => {
    mockPrisma.borisGroupReplyTracker.findUnique.mockResolvedValue(null)
    expect(await getLastBorisGroupReply('-100123')).toBeNull()
  })

  it('пустой chatId → null без запроса', async () => {
    expect(await getLastBorisGroupReply('')).toBeNull()
    expect(mockPrisma.borisGroupReplyTracker.findUnique).not.toHaveBeenCalled()
  })

  it('ошибка БД → null (fail-safe, не бросает)', async () => {
    mockPrisma.borisGroupReplyTracker.findUnique.mockRejectedValue(new Error('P1001'))
    expect(await getLastBorisGroupReply('-100123')).toBeNull()
  })
})

describe('recordBorisGroupReply', () => {
  it('upsert с create/update по tgChatId', async () => {
    mockPrisma.borisGroupReplyTracker.upsert.mockResolvedValue({})
    await recordBorisGroupReply('-100123', 555)
    expect(mockPrisma.borisGroupReplyTracker.upsert).toHaveBeenCalledWith({
      where: { tgChatId: '-100123' },
      create: { tgChatId: '-100123', lastReplyMessageId: 555 },
      update: { lastReplyMessageId: 555 },
    })
  })

  it('пустой chatId или нечисловой messageId → no-op', async () => {
    await recordBorisGroupReply('', 555)
    await recordBorisGroupReply('-100123', Number.NaN)
    expect(mockPrisma.borisGroupReplyTracker.upsert).not.toHaveBeenCalled()
  })

  it('ошибка БД → не бросает (swallowed)', async () => {
    mockPrisma.borisGroupReplyTracker.upsert.mockRejectedValue(new Error('P1001'))
    await expect(recordBorisGroupReply('-100123', 555)).resolves.toBeUndefined()
  })
})
