import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * #3 (after-cutoff): findLatestBotConv должен ловить СЕГОДНЯШНЮЮ EXPIRED-conv,
 * чтобы поздний ответ клиента (после того как cutoff-notice пометил conv EXPIRED
 * в 16:00) привязывался к сегодняшнему вопросу «на завтра», а не к вчерашней
 * CONFIRMED (deliveryDate=сегодня).
 *
 * NB: findFirst замокан → тест проверяет ФОРМУ запроса (наличие EXPIRED-today
 * ветки, граница mskMidnightUtc, ORDER BY). Реальный выбор «сегодняшняя EXPIRED
 * выигрывает у вчерашней CONFIRMED» — это поведение Postgres ORDER BY createdAt
 * DESC + WHERE, делегировано БД и не воспроизводится моком.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    botConversation: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

// Детерминированная граница «сегодня по МСК» — чтобы проверить, что EXPIRED-ветка
// ограничена именно ею.
const FIXED_TODAY_MSK = new Date('2026-06-06T21:00:00.000Z')
const { mockMsk } = vi.hoisted(() => ({ mockMsk: vi.fn() }))
vi.mock('@/lib/bot/daily-summary', () => ({ mskMidnightUtc: mockMsk }))

// isScheduledForDate тянется через generate-orders — мокаем, чтобы не грузить граф.
vi.mock('@/lib/orders/generate-orders', () => ({ isScheduledForDate: vi.fn() }))

import { findLatestBotConv } from './bot'

beforeEach(() => {
  vi.clearAllMocks()
  mockMsk.mockReturnValue(FIXED_TODAY_MSK)
  mockPrisma.botConversation.findFirst.mockResolvedValue(null)
})

describe('findLatestBotConv — late-ответ ловит сегодняшнюю EXPIRED', () => {
  it('выборка включает PENDING|CONFIRMED ИЛИ сегодняшнюю EXPIRED', async () => {
    await findLatestBotConv('client1')
    const arg = mockPrisma.botConversation.findFirst.mock.calls[0][0]
    expect(arg.where.clientId).toBe('client1')
    expect(arg.where.OR).toEqual(
      expect.arrayContaining([
        { status: { in: ['PENDING', 'CONFIRMED'] } },
        { status: 'EXPIRED', createdAt: { gte: FIXED_TODAY_MSK } },
      ])
    )
  })

  it('граница EXPIRED берётся из mskMidnightUtc(now, 0) — старые EXPIRED отсекаются', async () => {
    await findLatestBotConv('client1')
    expect(mockMsk).toHaveBeenCalledWith(expect.any(Date), 0)
    const arg = mockPrisma.botConversation.findFirst.mock.calls[0][0]
    const expiredBranch = arg.where.OR.find(
      (b: { status?: string }) => b.status === 'EXPIRED'
    )
    expect(expiredBranch.createdAt.gte).toBe(FIXED_TODAY_MSK)
  })

  it('сохраняет ORDER BY createdAt DESC и 30-дневное окно', async () => {
    await findLatestBotConv('client1')
    const arg = mockPrisma.botConversation.findFirst.mock.calls[0][0]
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date)
    // Окно ~30 дней назад от now (с запасом на время выполнения теста).
    const ageMs = Date.now() - (arg.where.createdAt.gte as Date).getTime()
    expect(ageMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000)
    expect(ageMs).toBeLessThan(31 * 24 * 60 * 60 * 1000)
  })
})
