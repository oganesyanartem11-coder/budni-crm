import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Per-day запрос заказов по @db.Date deliveryDate должен быть ТОЧНЫМ равенством
 * UTC-полуночи МСК-дня. Раньше было { gte: МСК-инстант полуночи (D−1 21:00Z),
 * lte: D 20:59:59.999Z } — Prisma усекает до UTC-дат → D−1..D (себестоимость ×2).
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    menuCycle: { findFirst: vi.fn() },
    order: { findMany: vi.fn() },
    ingredient: { findMany: vi.fn() },
    ingredientPriceHistory: { findMany: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import { getIngredientsConsumptionForRange } from './ingredients-consumption'

const run = (f: Date, t: Date) => getIngredientsConsumptionForRange(f, t, ['CONFIRMED'])

beforeEach(() => {
  vi.clearAllMocks()
  // Меню есть (пустые дни), заказов нет — доходим до запроса заказов каждого дня.
  mockPrisma.menuCycle.findFirst.mockResolvedValue({ days: [] })
  mockPrisma.order.findMany.mockResolvedValue([])
})

function orderDates(): string[] {
  return mockPrisma.order.findMany.mock.calls.map((c) => (c[0].where.deliveryDate as Date).toISOString())
}

describe('getIngredientsConsumptionForRange — per-day границы @db.Date', () => {
  it('один МСК-день 19.10, заданный МСК-инстантами (Пред.день 21:00Z … 20:59:59.999Z) → deliveryDate = 19.10 00:00Z', async () => {
    const res = await run(new Date('2026-10-18T21:00:00.000Z'), new Date('2026-10-19T20:59:59.999Z'))
    expect(res.totalDays).toBe(1)
    expect(orderDates()).toEqual(['2026-10-19T00:00:00.000Z'])
  })

  it('тот же день, заданный UTC-полуночами (как getPresetRange/context-builder) → тот же один запрос', async () => {
    const res = await run(new Date('2026-10-19T00:00:00.000Z'), new Date('2026-10-19T00:00:00.000Z'))
    expect(res.totalDays).toBe(1)
    expect(orderDates()).toEqual(['2026-10-19T00:00:00.000Z'])
  })

  it('фин-неделя Сб 17.10 → Пт 23.10: 7 запросов, каждый ровно свой день; меню ищется по МСК-инстанту', async () => {
    const res = await run(new Date('2026-10-17T00:00:00.000Z'), new Date('2026-10-23T20:59:59.999Z'))
    expect(res.totalDays).toBe(7)
    expect(orderDates()).toEqual([
      '2026-10-17T00:00:00.000Z',
      '2026-10-18T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-22T00:00:00.000Z',
      '2026-10-23T00:00:00.000Z',
    ])
    // MenuCycle.validFrom/validTo — DateTime (МСК-инстанты понедельника), не трогали.
    expect(mockPrisma.menuCycle.findFirst.mock.calls[0][0].where.validFrom).toEqual({
      lte: new Date('2026-10-16T21:00:00.000Z'),
    })
  })
})
