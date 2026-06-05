import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Волна 4: сервисная выручка (доставка) в производственной сводке дня.
 *  - totalRevenue (food) НЕ меняется (delivery=0).
 *  - deliveryRevenue добавлена за тот же день, отдельным полем.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn() },
    menuCycle: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

const { mockDelivery } = vi.hoisted(() => ({
  mockDelivery: { sumDeliveryRevenue: vi.fn() },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => mockDelivery)

import { getProductionSummary } from './production'

const DAY = new Date('2026-06-02T00:00:00.000Z')

function order(opts: { price: number; mealType?: 'BREAKFAST' | 'LUNCH' | 'DINNER' }) {
  return {
    id: Math.random().toString(36),
    mealType: opts.mealType ?? 'LUNCH',
    portions: 10,
    totalPrice: new Prisma.Decimal(opts.price),
    locationId: 'loc1',
  }
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
  mockPrisma.menuCycle.findFirst.mockReset()
  mockDelivery.sumDeliveryRevenue.mockReset()
  mockPrisma.menuCycle.findFirst.mockResolvedValue(null)
})

describe('getProductionSummary — сервисная выручка', () => {
  it('food totalRevenue не меняется; deliveryRevenue=0 при отсутствии доставки', async () => {
    mockPrisma.order.findMany
      .mockResolvedValueOnce([order({ price: 1000 }), order({ price: 500 })]) // активные
      .mockResolvedValueOnce([]) // pending
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(0))

    const s = await getProductionSummary(DAY)

    expect(s.totalRevenue).toBe(1500)
    expect(s.deliveryRevenue).toBe(0)
  })

  it('deliveryRevenue добавлена отдельным полем, food не тронут', async () => {
    mockPrisma.order.findMany
      .mockResolvedValueOnce([order({ price: 1000 })])
      .mockResolvedValueOnce([])
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(300))

    const s = await getProductionSummary(DAY)

    expect(s.totalRevenue).toBe(1000)
    expect(s.deliveryRevenue).toBe(300)
  })
})
