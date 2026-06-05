import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Волна 4: сервисная выручка (доставка) в аналитике клиента.
 *  - food totalRevenue / location.revenue НЕ меняются (delivery=0).
 *  - deliveryRevenue добавлена на уровне клиента и каждой локации, отдельно.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn() } },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

const { mockDelivery } = vi.hoisted(() => ({
  mockDelivery: { deliveryRevenueByLocation: vi.fn() },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => mockDelivery)

import { getClientAnalytics } from './client-analytics'

function order(opts: { date: string; price: number; locationId?: string }) {
  return {
    id: Math.random().toString(36),
    deliveryDate: new Date(opts.date),
    mealType: 'LUNCH' as const,
    portions: 10,
    totalPrice: new Prisma.Decimal(opts.price),
    status: 'CONFIRMED' as const,
    locationId: opts.locationId ?? 'loc1',
    location: { id: opts.locationId ?? 'loc1', name: opts.locationId ?? 'loc1' },
  }
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
  mockDelivery.deliveryRevenueByLocation.mockReset()
})

describe('getClientAnalytics — сервисная выручка', () => {
  // Используем недавнюю дату (в пределах 12-мес. окна) — иначе заказ выпадет.
  const recent = new Date()
  recent.setDate(recent.getDate() - 2)
  const recentIso = recent.toISOString()

  it('food не меняется при отсутствии доставки', async () => {
    mockPrisma.order.findMany.mockResolvedValue([order({ date: recentIso, price: 1000 })])
    mockDelivery.deliveryRevenueByLocation.mockResolvedValue([])

    const a = await getClientAnalytics('client-x')

    expect(a.totalRevenue).toBe(1000)
    expect(a.deliveryRevenue).toBe(0)
    for (const loc of a.locations) expect(loc.deliveryRevenue).toBe(0)
  })

  it('deliveryRevenue привязывается к локациям клиента отдельно от food', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: recentIso, price: 1000, locationId: 'loc1' }),
      order({ date: recentIso, price: 500, locationId: 'loc2' }),
    ])
    mockDelivery.deliveryRevenueByLocation.mockResolvedValue([
      {
        locationId: 'loc1',
        locationName: 'loc1',
        clientId: 'client-x',
        clientName: 'X',
        deliveryRevenue: new Prisma.Decimal(200),
        daysWithDelivery: 2,
      },
      {
        locationId: 'loc2',
        locationName: 'loc2',
        clientId: 'client-x',
        clientName: 'X',
        deliveryRevenue: new Prisma.Decimal(50),
        daysWithDelivery: 1,
      },
      // Чужой клиент — должен игнорироваться.
      {
        locationId: 'locZ',
        locationName: 'locZ',
        clientId: 'other-client',
        clientName: 'Other',
        deliveryRevenue: new Prisma.Decimal(9999),
        daysWithDelivery: 5,
      },
    ])

    const a = await getClientAnalytics('client-x')

    expect(a.totalRevenue).toBe(1500) // food unchanged
    expect(a.deliveryRevenue).toBe(250) // 200 + 50, чужой клиент исключён

    const loc1 = a.locations.find((l) => l.locationId === 'loc1')!
    const loc2 = a.locations.find((l) => l.locationId === 'loc2')!
    expect(loc1.revenue).toBe(1000)
    expect(loc1.deliveryRevenue).toBe(200)
    expect(loc2.revenue).toBe(500)
    expect(loc2.deliveryRevenue).toBe(50)
  })
})
