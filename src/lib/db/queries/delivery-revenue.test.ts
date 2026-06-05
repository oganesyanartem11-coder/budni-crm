import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Волна 4: сервисная выручка. Главное свойство — fee один раз на (локация, день),
 * даже если в этот день у локации несколько mealType-заказов.
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn() } },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  sumDeliveryRevenue,
  deliveryRevenueByDay,
  deliveryRevenueByLocation,
  deliveryRevenueByClient,
} from './delivery-revenue'

const FROM = new Date('2026-06-01T00:00:00.000Z')
const TO = new Date('2026-06-08T00:00:00.000Z')

function row(opts: {
  locationId: string
  date: string
  fee: number | null
  locName?: string
  clientId?: string
  clientName?: string
}) {
  return {
    locationId: opts.locationId,
    deliveryDate: new Date(opts.date),
    location:
      opts.fee === null && opts.locName === undefined
        ? { name: 'L', deliveryFee: null, clientId: opts.clientId ?? 'c1', client: { name: opts.clientName ?? 'Client' } }
        : {
            name: opts.locName ?? 'L',
            deliveryFee: opts.fee === null ? null : new Prisma.Decimal(opts.fee),
            clientId: opts.clientId ?? 'c1',
            client: { name: opts.clientName ?? 'Client' },
          },
  }
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
})

describe('sumDeliveryRevenue', () => {
  it('локация без deliveryFee (null) → 0', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-02', fee: null }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('0.00')
  })

  it('fee=500, один заказ в день → 500', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('500.00')
  })

  it('ГЛАВНЫЙ КЕЙС: fee=500, 3 mealType-заказа в ОДИН день → 500, не 1500', async () => {
    // Если бы prisma distinct не сработал — JS-дедуп всё равно схлопнет в одну доставку.
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('500.00')
  })

  it('fee=500 в 5 разных днях → 2500', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-01', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-03', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-04', fee: 500 }),
      row({ locationId: 'loc1', date: '2026-06-05', fee: 500 }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('2500.00')
  })

  it('копейки: fee=499.99 × 2 дня → 999.98 (Decimal-точность)', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-01', fee: 499.99 }),
      row({ locationId: 'loc1', date: '2026-06-02', fee: 499.99 }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('999.98')
  })

  it('CANCELLED/DRAFT не доходят до хелпера (фильтр в where) — проверяем where', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await sumDeliveryRevenue({ from: FROM, to: TO })
    const arg = mockPrisma.order.findMany.mock.calls[0][0]
    expect(arg.where.status.in).toEqual([
      'CONFIRMED',
      'LOCKED',
      'IN_PRODUCTION',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ])
    expect(arg.where.status.in).not.toContain('CANCELLED')
    expect(arg.where.status.in).not.toContain('DRAFT')
    // период [from, to): верхняя граница exclusive (lt).
    expect(arg.where.deliveryDate).toEqual({ gte: FROM, lt: TO })
    expect(arg.distinct).toEqual(['locationId', 'deliveryDate'])
  })

  it('смешанные локации: с fee и без → суммируются только с fee', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500 }),
      row({ locationId: 'loc2', date: '2026-06-02', fee: null }),
      row({ locationId: 'loc3', date: '2026-06-02', fee: 300 }),
    ])
    const sum = await sumDeliveryRevenue({ from: FROM, to: TO })
    expect(sum.toFixed(2)).toBe('800.00')
  })
})

describe('deliveryRevenueByDay', () => {
  it('группирует по дню, сортирует по дате', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-03', fee: 500 }),
      row({ locationId: 'loc2', date: '2026-06-03', fee: 300 }),
      row({ locationId: 'loc1', date: '2026-06-01', fee: 500 }),
    ])
    const byDay = await deliveryRevenueByDay({ from: FROM, to: TO })
    expect(byDay.map((d) => d.deliveryRevenue.toFixed(2))).toEqual(['500.00', '800.00'])
    expect(byDay[0].date.toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('deliveryRevenueByLocation', () => {
  it('сумма + число дней с доставкой по локации', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-01', fee: 500, locName: 'Аэропорт' }),
      row({ locationId: 'loc1', date: '2026-06-02', fee: 500, locName: 'Аэропорт' }),
      row({ locationId: 'loc2', date: '2026-06-01', fee: 300, locName: 'ТЭЦ' }),
    ])
    const byLoc = await deliveryRevenueByLocation({ from: FROM, to: TO })
    const a = byLoc.find((l) => l.locationId === 'loc1')!
    expect(a.deliveryRevenue.toFixed(2)).toBe('1000.00')
    expect(a.daysWithDelivery).toBe(2)
    expect(a.locationName).toBe('Аэропорт')
  })
})

describe('deliveryRevenueByClient', () => {
  it('сумма по клиентам', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      row({ locationId: 'loc1', date: '2026-06-01', fee: 500, clientId: 'cA', clientName: 'A' }),
      row({ locationId: 'loc2', date: '2026-06-01', fee: 300, clientId: 'cA', clientName: 'A' }),
      row({ locationId: 'loc3', date: '2026-06-01', fee: 200, clientId: 'cB', clientName: 'B' }),
    ])
    const byClient = await deliveryRevenueByClient({ from: FROM, to: TO })
    expect(byClient.find((c) => c.clientId === 'cA')!.deliveryRevenue.toFixed(2)).toBe('800.00')
    expect(byClient.find((c) => c.clientId === 'cB')!.deliveryRevenue.toFixed(2)).toBe('200.00')
  })
})
