import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Волна 4: сервисная выручка (доставка) в дашборде/марже.
 *
 * Ключевые свойства:
 *  - foodRevenue (totalRevenue) НЕ меняется, когда доставки нет (helper → 0).
 *  - deliveryRevenue присутствует отдельным полем; grandTotal = food + delivery.
 *  - Маржа считается СТРОГО по еде и НЕ зависит от deliveryRevenue.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn(), aggregate: vi.fn() },
  },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

const { mockDelivery } = vi.hoisted(() => ({
  mockDelivery: {
    sumDeliveryRevenue: vi.fn(),
    deliveryRevenueByDay: vi.fn(),
  },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => mockDelivery)

const { mockMaterialCost } = vi.hoisted(() => ({
  mockMaterialCost: { getMaterialCostForRange: vi.fn() },
}))
vi.mock('@/lib/digest/material-cost', () => mockMaterialCost)

import { getAdminDashboardData, getMarginForPeriod } from './dashboard-stats'

const FROM = new Date('2026-06-01T00:00:00.000Z')
const TO = new Date('2026-06-03T00:00:00.000Z')

function order(opts: { date: string; price: number; clientId?: string; portions?: number }) {
  return {
    id: Math.random().toString(36),
    deliveryDate: new Date(opts.date),
    portions: opts.portions ?? 10,
    totalPrice: new Prisma.Decimal(opts.price),
    clientId: opts.clientId ?? 'c1',
    client: { id: opts.clientId ?? 'c1', name: 'Client' },
  }
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
  mockPrisma.order.aggregate.mockReset()
  mockDelivery.sumDeliveryRevenue.mockReset()
  mockDelivery.deliveryRevenueByDay.mockReset()
  mockMaterialCost.getMaterialCostForRange.mockReset()
})

describe('getAdminDashboardData — сервисная выручка', () => {
  it('foodRevenue не меняется, когда доставки нет (helper → 0)', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
      order({ date: '2026-06-02T00:00:00.000Z', price: 500 }),
    ])
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(0))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([])

    const data = await getAdminDashboardData(FROM, TO)

    expect(data.thisPeriod.totalRevenue).toBe(1500)
    expect(data.thisPeriod.foodRevenue).toBe(1500)
    expect(data.thisPeriod.deliveryRevenue).toBe(0)
    expect(data.thisPeriod.grandTotalRevenue).toBe(1500)
  })

  it('deliveryRevenue присутствует отдельным полем; grandTotal = food + delivery', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
    ])
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(300))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([
      { date: new Date('2026-06-01T00:00:00.000Z'), deliveryRevenue: new Prisma.Decimal(300) },
    ])

    const data = await getAdminDashboardData(FROM, TO)

    expect(data.thisPeriod.foodRevenue).toBe(1000)
    expect(data.thisPeriod.deliveryRevenue).toBe(300)
    expect(data.thisPeriod.grandTotalRevenue).toBe(1300)
    // food-выручка (totalRevenue) не «съедает» доставку.
    expect(data.thisPeriod.totalRevenue).toBe(1000)
  })

  it('daily-точка получает deliveryRevenue через join по дате; food.revenue не меняется', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
      order({ date: '2026-06-02T00:00:00.000Z', price: 700 }),
    ])
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(300))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([
      { date: new Date('2026-06-02T00:00:00.000Z'), deliveryRevenue: new Prisma.Decimal(300) },
    ])

    const data = await getAdminDashboardData(FROM, TO)

    const d1 = data.thisPeriod.daily.find((d) => d.date === '2026-06-01')!
    const d2 = data.thisPeriod.daily.find((d) => d.date === '2026-06-02')!
    expect(d1.revenue).toBe(1000)
    expect(d1.deliveryRevenue).toBe(0)
    expect(d2.revenue).toBe(700)
    expect(d2.deliveryRevenue).toBe(300)
  })

  it('WoW считает доставку для обоих окон', async () => {
    // ongoing=false проще: today вне диапазона → берём totalRevenue.
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
    ])
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { totalPrice: new Prisma.Decimal(800) } })
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([])
    // sumDeliveryRevenue вызывается: период, compareWindow, (thisUpToCutoff если ongoing).
    mockDelivery.sumDeliveryRevenue
      .mockResolvedValueOnce(new Prisma.Decimal(300)) // период
      .mockResolvedValue(new Prisma.Decimal(150)) // compare window

    const data = await getAdminDashboardData(FROM, TO, { withWoW: true })

    expect(data.wow).not.toBeNull()
    expect(data.wow!.deliveryRevenue).toBeTypeOf('number')
    expect(data.wow!.comparePrevDeliveryRevenue).toBe(150)
    // food WoW сравнение не сломано.
    expect(data.wow!.comparePrevRevenue).toBe(800)
  })
})

describe('getMarginForPeriod — маржа независима от доставки', () => {
  beforeEach(() => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
    ])
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { totalPrice: new Prisma.Decimal(0) } })
    mockMaterialCost.getMaterialCostForRange.mockResolvedValue({ totalCost: 400, daysWithoutMenu: 0 })
  })

  it('маржа = (food − cost)/food, не зависит от deliveryRevenue', async () => {
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(0))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([])
    const noDelivery = await getMarginForPeriod(FROM, TO)

    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(9999))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([
      { date: new Date('2026-06-01T00:00:00.000Z'), deliveryRevenue: new Prisma.Decimal(9999) },
    ])
    const withDelivery = await getMarginForPeriod(FROM, TO)

    // Маржа идентична, несмотря на огромную доставку.
    expect(noDelivery.marginAbsolute).toBe(600) // 1000 - 400
    expect(withDelivery.marginAbsolute).toBe(600)
    expect(noDelivery.marginPct).toBe(withDelivery.marginPct)
    expect(noDelivery.totalRevenue).toBe(1000)
    expect(withDelivery.totalRevenue).toBe(1000) // food-база маржи

    // deliveryRevenue присутствует отдельным полем.
    expect(noDelivery.deliveryRevenue).toBe(0)
    expect(withDelivery.deliveryRevenue).toBe(9999)
  })
})
