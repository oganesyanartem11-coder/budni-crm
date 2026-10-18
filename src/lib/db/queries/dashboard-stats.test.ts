import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import { getPresetRange } from '@/lib/utils/week'

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

/**
 * Аудит дат 18.10. Контракт: [from, to] — включительные МСК-дни; в @db.Date и
 * delivery-revenue идут UTC-полночи { gte: первый день, lt: день после }.
 * Раньше: delivery получал endOfDay(to) при `lt` → «Сегодня» доставка = 0;
 * WoW считал today через серверный setHours (UTC) → в 00:00–03:00 МСК «вчера».
 */
describe('getAdminDashboardData — границы дат (МСК)', () => {
  beforeEach(() => {
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.order.aggregate.mockResolvedValue({ _sum: { totalPrice: new Prisma.Decimal(0) } })
    mockDelivery.sumDeliveryRevenue.mockResolvedValue(new Prisma.Decimal(0))
    mockDelivery.deliveryRevenueByDay.mockResolvedValue([])
  })
  afterEach(() => vi.useRealTimers())

  it.each([
    ['ночь 19.10 01:30 МСК', '2026-10-18T22:30:00.000Z'],
    ['день 19.10 12:00 МСК', '2026-10-19T09:00:00.000Z'],
  ])('«Сегодня» (%s): заказы и доставка ровно за 19.10', async (_n, nowIso) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    const { from, to } = getPresetRange('today')
    await getAdminDashboardData(from, to)

    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-19T00:00:00.000Z'),
      lt: new Date('2026-10-20T00:00:00.000Z'),
    })
    const expected = { from: new Date('2026-10-19T00:00:00.000Z'), to: new Date('2026-10-20T00:00:00.000Z') }
    expect(mockDelivery.sumDeliveryRevenue).toHaveBeenCalledWith(expected)
    expect(mockDelivery.deliveryRevenueByDay).toHaveBeenCalledWith(expected)
  })

  it('this_week ночью 19.10 01:30 МСК: 7 дней Сб–Пт, подписи по дням недели, WoW прорейт 3 дня', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T22:30:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([
      order({ date: '2026-10-19T00:00:00.000Z', price: 1000 }),
    ])
    const { from, to } = getPresetRange('this_week')
    const data = await getAdminDashboardData(from, to, { withWoW: true })

    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-17T00:00:00.000Z'),
      lt: new Date('2026-10-24T00:00:00.000Z'),
    })
    expect(data.thisPeriod.daily.map((d) => d.dayLabel)).toEqual([
      'Сб 17.10', 'Вс 18.10', 'Пн 19.10', 'Вт 20.10', 'Ср 21.10', 'Чт 22.10', 'Пт 23.10',
    ])
    expect(data.thisPeriod.daily.find((d) => d.date === '2026-10-19')!.revenue).toBe(1000)

    // МСК-сегодня = Пн 19.10 → сравниваем Сб..Пн (3 дня) с теми же днями −7.
    expect(data.wow!.daysCompared).toBe(3)
    const aggWheres = mockPrisma.order.aggregate.mock.calls.map((c) => c[0].where.deliveryDate)
    expect(aggWheres).toEqual([
      { gte: new Date('2026-10-10T00:00:00.000Z'), lt: new Date('2026-10-13T00:00:00.000Z') },
      { gte: new Date('2026-10-17T00:00:00.000Z'), lt: new Date('2026-10-20T00:00:00.000Z') },
    ])
    expect(mockDelivery.sumDeliveryRevenue).toHaveBeenCalledWith({
      from: new Date('2026-10-10T00:00:00.000Z'),
      to: new Date('2026-10-13T00:00:00.000Z'),
    })
    expect(mockDelivery.sumDeliveryRevenue).toHaveBeenCalledWith({
      from: new Date('2026-10-17T00:00:00.000Z'),
      to: new Date('2026-10-20T00:00:00.000Z'),
    })
  })
})
