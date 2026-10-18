import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

/**
 * Аудит дат 18.10: подписи недель читали getDate() у МСК-инстанта Пт 21:00Z на
 * UTC-сервере («16–23 окт», Пт–Пт); `lte: now` в 00:00–03:00 МСК терял сегодня;
 * delivery с `to: now` при `lt` терял сегодня всегда.
 */
describe('getClientAnalytics — границы дат (МСК)', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['ночь 19.10 01:30 МСК', '2026-10-18T22:30:00.000Z'],
    ['день 19.10 12:00 МСК', '2026-10-19T09:00:00.000Z'],
  ])('%s: окно 1.10.2025 … 19.10 включительно; подписи Сб–Пт; заказ сегодня в текущей неделе', async (_n, nowIso) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-10-19T00:00:00.000Z', price: 1000 }),
      order({ date: '2026-10-16T00:00:00.000Z', price: 300 }), // Пт прошлой фин-недели
    ])
    mockDelivery.deliveryRevenueByLocation.mockResolvedValue([])

    const a = await getClientAnalytics('client-x')

    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2025-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-20T00:00:00.000Z'),
    })
    expect(mockDelivery.deliveryRevenueByLocation).toHaveBeenCalledWith({
      from: new Date('2025-10-01T00:00:00.000Z'),
      to: new Date('2026-10-20T00:00:00.000Z'),
    })

    const last = a.weekly[a.weekly.length - 1]
    expect(last.key).toBe('2026-10-17')
    expect(last.label).toBe('17–23 окт')
    expect(last.revenue).toBe(1000)
    const prev = a.weekly[a.weekly.length - 2]
    expect(prev.label).toBe('10–16 окт')
    expect(prev.revenue).toBe(300)
    expect(a.weekly).toHaveLength(12)

    expect(a.monthly).toHaveLength(12)
    expect(a.monthly[a.monthly.length - 1]).toMatchObject({ key: '2026-10', label: 'Октябрь 2026', revenue: 1300 })
    expect(a.monthly[0].key).toBe('2025-11')
  })

  it('подпись недели на стыке месяцев: Сб 26.09 … Пт 2.10', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T09:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([])
    mockDelivery.deliveryRevenueByLocation.mockResolvedValue([])
    const a = await getClientAnalytics('client-x')
    expect(a.weekly[a.weekly.length - 1].label).toBe('26 сен – 2 окт')
  })
})
