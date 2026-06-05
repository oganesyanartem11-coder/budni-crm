import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Волна 4: сервисная выручка (доставка) в финансовом отчёте.
 *  - food totalRevenue/daily.revenue/client.revenue НЕ меняются (delivery=0).
 *  - deliveryRevenue добавлена в daily, по клиентам и в шапке отчёта.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn() } },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

const { mockDelivery } = vi.hoisted(() => ({
  mockDelivery: {
    deliveryRevenueByDay: vi.fn(),
    deliveryRevenueByClient: vi.fn(),
  },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => mockDelivery)

import { getFinancialReport } from './reports'

const FROM = new Date('2026-06-01T00:00:00.000Z')
const TO = new Date('2026-06-02T00:00:00.000Z')

function order(opts: { date: string; price: number; clientId?: string }) {
  return {
    id: Math.random().toString(36),
    deliveryDate: new Date(opts.date),
    portions: 10,
    totalPrice: new Prisma.Decimal(opts.price),
    status: 'CONFIRMED' as const,
    clientId: opts.clientId ?? 'c1',
    client: { id: opts.clientId ?? 'c1', name: 'Client' },
  }
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset()
  mockDelivery.deliveryRevenueByDay.mockReset()
  mockDelivery.deliveryRevenueByClient.mockReset()
})

describe('getFinancialReport — сервисная выручка', () => {
  it('food не меняется при отсутствии доставки', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000 }),
      order({ date: '2026-06-02T00:00:00.000Z', price: 500 }),
    ])
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([])
    mockDelivery.deliveryRevenueByClient.mockResolvedValue([])

    const report = await getFinancialReport(FROM, TO)

    expect(report.totalRevenue).toBe(1500)
    expect(report.deliveryRevenue).toBe(0)
    for (const d of report.daily) expect(d.deliveryRevenue).toBe(0)
    for (const c of report.clients) expect(c.deliveryRevenue).toBe(0)
  })

  it('deliveryRevenue раскладывается по дням и клиентам отдельно от food', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-06-01T00:00:00.000Z', price: 1000, clientId: 'c1' }),
      order({ date: '2026-06-02T00:00:00.000Z', price: 500, clientId: 'c2' }),
    ])
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([
      { date: new Date('2026-06-01T00:00:00.000Z'), deliveryRevenue: new Prisma.Decimal(200) },
      { date: new Date('2026-06-02T00:00:00.000Z'), deliveryRevenue: new Prisma.Decimal(100) },
    ])
    mockDelivery.deliveryRevenueByClient.mockResolvedValue([
      { clientId: 'c1', clientName: 'Client', deliveryRevenue: new Prisma.Decimal(200) },
      { clientId: 'c2', clientName: 'Client', deliveryRevenue: new Prisma.Decimal(100) },
    ])

    const report = await getFinancialReport(FROM, TO)

    expect(report.totalRevenue).toBe(1500) // food unchanged
    expect(report.deliveryRevenue).toBe(300)

    const d1 = report.daily.find((d) => d.date === '2026-06-01')!
    const d2 = report.daily.find((d) => d.date === '2026-06-02')!
    expect(d1.revenue).toBe(1000)
    expect(d1.deliveryRevenue).toBe(200)
    expect(d2.deliveryRevenue).toBe(100)

    const c1 = report.clients.find((c) => c.clientId === 'c1')!
    const c2 = report.clients.find((c) => c.clientId === 'c2')!
    expect(c1.revenue).toBe(1000)
    expect(c1.deliveryRevenue).toBe(200)
    expect(c2.deliveryRevenue).toBe(100)
  })
})
