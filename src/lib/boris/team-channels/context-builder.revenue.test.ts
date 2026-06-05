import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Волна 4: Командный Боря получает food + delivery раздельно в контексте дня/недели.
 *  - revenueRub (== foodRevenueRub) НЕ меняется при отсутствии доставки.
 *  - deliveryRevenueRub присутствует; totalRevenueRub = food + delivery.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { aggregate: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    borisEventLog: { findMany: vi.fn() },
    clientAlertLog: { groupBy: vi.fn(), count: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

const { mockDelivery } = vi.hoisted(() => ({
  mockDelivery: { sumDeliveryRevenue: vi.fn() },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => mockDelivery)

vi.mock('@/lib/digest/material-cost', () => ({
  getMaterialCostForRange: vi.fn().mockResolvedValue({ totalCost: 0, daysWithoutMenu: 0 }),
}))

import { buildDayContext, buildWeekContext } from './context-builder'

const NOW = new Date('2026-06-02T09:00:00.000Z')

beforeEach(() => {
  mockPrisma.order.aggregate.mockReset()
  mockPrisma.order.findMany.mockReset()
  mockPrisma.order.findFirst.mockReset()
  mockPrisma.borisEventLog.findMany.mockReset()
  mockPrisma.clientAlertLog.groupBy.mockReset()
  mockPrisma.clientAlertLog.count.mockReset()
  mockDelivery.sumDeliveryRevenue.mockReset()

  mockPrisma.order.aggregate.mockResolvedValue({
    _sum: { totalPrice: 1000, portions: 50 },
    _count: { _all: 5 },
  })
  mockPrisma.order.findMany.mockResolvedValue([])
  mockPrisma.order.findFirst.mockResolvedValue(null)
  mockPrisma.borisEventLog.findMany.mockResolvedValue([])
  mockPrisma.clientAlertLog.groupBy.mockResolvedValue([])
  mockPrisma.clientAlertLog.count.mockResolvedValue(0)
})

describe('buildDayContext — food/delivery split', () => {
  it('delivery=0 → revenueRub == foodRevenueRub == totalRevenueRub', async () => {
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(0)
    const ctx = await buildDayContext(NOW)
    expect(ctx.today.revenueRub).toBe(1000)
    expect(ctx.today.foodRevenueRub).toBe(1000)
    expect(ctx.today.deliveryRevenueRub).toBe(0)
    expect(ctx.today.totalRevenueRub).toBe(1000)
  })

  it('delivery>0 → deliveryRevenueRub отдельно, total = food + delivery', async () => {
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(300)
    const ctx = await buildDayContext(NOW)
    expect(ctx.today.foodRevenueRub).toBe(1000)
    expect(ctx.today.deliveryRevenueRub).toBe(300)
    expect(ctx.today.totalRevenueRub).toBe(1300)
  })
})

describe('buildWeekContext — food/delivery split', () => {
  it('delivery>0 → week total = food + delivery; food не тронут', async () => {
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(700)
    const ctx = await buildWeekContext(NOW)
    expect(ctx.revenueRub).toBe(1000)
    expect(ctx.foodRevenueRub).toBe(1000)
    expect(ctx.deliveryRevenueRub).toBe(700)
    expect(ctx.totalRevenueRub).toBe(1700)
  })
})
