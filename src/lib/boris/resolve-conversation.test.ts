import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * #4: resolveActiveConversation должна ключевать беседу по userId + chatId,
 * чтобы личная и групповая истории Бори были РАЗДЕЛЬНЫМИ. Раньше ключ был
 * только userId → групповые отказы протекали в личный контекст и копились.
 *
 * findFirst/create замоканы → проверяем ФОРМУ запросов (chatId во всех ветках)
 * и поведение reuse/create. Реальную выборку делегируем Postgres.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    borisConversation: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import { resolveActiveConversation } from './agent'

const NOW = new Date('2026-06-08T10:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.borisConversation.findFirst.mockResolvedValue(null)
  mockPrisma.borisConversation.update.mockResolvedValue({})
  mockPrisma.borisConversation.create.mockImplementation(
    (args: { data: Record<string, unknown> }) => ({ id: 'new_conv', ...args.data })
  )
})

describe('resolveActiveConversation — #4 ключевание по chatId', () => {
  it('explicit conversationId — reuse фильтруется по chatId (чужой чат не подхватится)', async () => {
    mockPrisma.borisConversation.findFirst.mockResolvedValueOnce({ id: 'c1', userId: 'u1' })
    const conv = await resolveActiveConversation('u1', 'c1', 'chatA', NOW)
    expect(conv).toEqual({ id: 'c1', userId: 'u1' })
    expect(mockPrisma.borisConversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1', userId: 'u1', chatId: 'chatA', closedAt: null },
    })
  })

  it('last-by-user lookup включает chatId в where', async () => {
    await resolveActiveConversation('u1', undefined, 'chatA', NOW)
    expect(mockPrisma.borisConversation.findFirst).toHaveBeenLastCalledWith({
      where: { userId: 'u1', chatId: 'chatA', closedAt: null },
      orderBy: { lastMessageAt: 'desc' },
    })
  })

  it('create новой беседы записывает chatId', async () => {
    // нет открытой беседы → findFirst=null → create
    await resolveActiveConversation('u1', undefined, 'chatA', NOW)
    expect(mockPrisma.borisConversation.create).toHaveBeenCalledWith({
      data: { userId: 'u1', chatId: 'chatA' },
    })
  })

  it('свежая беседа того же chatId — reuse без create', async () => {
    mockPrisma.borisConversation.findFirst.mockResolvedValueOnce({
      id: 'c1',
      userId: 'u1',
      lastMessageAt: new Date(NOW.getTime() - 60_000), // 1 мин назад, в пределах TTL
    })
    const conv = await resolveActiveConversation('u1', undefined, 'chatA', NOW)
    expect(conv).toMatchObject({ id: 'c1' })
    expect(mockPrisma.borisConversation.create).not.toHaveBeenCalled()
  })

  it('stale беседа — закрывается и создаётся новая с тем же chatId', async () => {
    mockPrisma.borisConversation.findFirst.mockResolvedValueOnce({
      id: 'c1',
      userId: 'u1',
      lastMessageAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000), // 3ч назад > TTL 2ч
    })
    await resolveActiveConversation('u1', undefined, 'chatA', NOW)
    expect(mockPrisma.borisConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } })
    )
    expect(mockPrisma.borisConversation.create).toHaveBeenCalledWith({
      data: { userId: 'u1', chatId: 'chatA' },
    })
  })
})
