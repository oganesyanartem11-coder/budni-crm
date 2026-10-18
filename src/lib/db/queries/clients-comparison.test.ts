import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Аудит дат 18.10: в запрос шли сырые from/to. this_week.from = МСК-инстант
 * Пт 21:00Z → Prisma усекает до пятницы → «эта неделя» 8 дней (Пт–Пт), а prev
 * сдвигался на 7 суток от инстантов. Теперь — UTC-полночи МСК-дней, half-open.
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn() } },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import { getClientsComparison } from './clients-comparison'
import { getPresetRange } from '@/lib/utils/week'

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('getClientsComparison — границы дат (МСК)', () => {
  it.each([
    ['ночь 19.10 01:30 МСК', '2026-10-18T22:30:00.000Z'],
    ['день 19.10 12:00 МСК', '2026-10-19T09:00:00.000Z'],
  ])('this_week (%s): curr = 17.10..23.10, prev = 10.10..16.10', async (_n, nowIso) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    mockPrisma.order.findMany.mockResolvedValue([])
    const { from, to } = getPresetRange('this_week')
    await getClientsComparison(from, to)

    const wheres = mockPrisma.order.findMany.mock.calls.map((c) => c[0].where.deliveryDate)
    expect(wheres).toEqual([
      { gte: new Date('2026-10-17T00:00:00.000Z'), lt: new Date('2026-10-24T00:00:00.000Z') },
      { gte: new Date('2026-10-10T00:00:00.000Z'), lt: new Date('2026-10-17T00:00:00.000Z') },
    ])
  })

  it('старый МСК-инстант from (Пт 21:00Z) тоже нормализуется к субботе', async () => {
    mockPrisma.order.findMany
      .mockResolvedValueOnce([
        { clientId: 'c1', totalPrice: new Prisma.Decimal(1000), portions: 10, client: { name: 'A' } },
      ])
      .mockResolvedValueOnce([{ clientId: 'c1', totalPrice: new Prisma.Decimal(500) }])
    const res = await getClientsComparison(
      new Date('2026-10-16T21:00:00.000Z'),
      new Date('2026-10-23T20:59:59.999Z'),
    )
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate.gte).toEqual(
      new Date('2026-10-17T00:00:00.000Z'),
    )
    expect(res.rows[0].growthPct).toBe(100)
  })
})
