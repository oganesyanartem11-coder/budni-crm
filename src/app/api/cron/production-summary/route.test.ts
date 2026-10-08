import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockPrisma, mockNotify } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn() },
    clientMealConfig: { findMany: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn() },
  },
  mockNotify: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/telegram/notify', () => ({
  notifyProductionChannel: mockNotify,
  escapeHtml: (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))
vi.mock('@/lib/telegram/buttons', () => ({ productionSummaryButton: () => undefined }))
vi.mock('@/lib/db/queries/delivery-revenue', () => ({ sumDeliveryRevenue: vi.fn(async () => 0) }))
vi.mock('@/lib/cron/with-heartbeat', () => ({ withCronHeartbeat: (_: string, h: unknown) => h }))

import { handler } from './route'

const REQ = new Request('http://x/api/cron/production-summary')
// пн 08.06.2026 16:00 МСК → завтра вт 09.06.
const NOW = new Date('2026-06-08T13:00:00.000Z')

const order = (over: Record<string, unknown>) => ({
  portions: 10,
  totalPrice: 3000,
  sourceConfigId: null,
  clientId: 'c1',
  locationId: 'l1',
  mealType: 'LUNCH',
  status: 'CONFIRMED',
  client: { id: 'c1', name: 'Фикс' },
  location: { id: 'l1', name: 'Офис' },
  ...over,
})

const dynConfig = {
  clientId: 'c2',
  locationId: 'l2',
  mealType: 'LUNCH',
  scheduleType: 'DAILY',
  scheduleData: null,
  validFrom: null,
  validTo: null,
  client: { name: 'Динамик' },
  location: { name: 'Склад' },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({})
  mockPrisma.clientMealConfig.findMany.mockResolvedValue([dynConfig])
})
afterEach(() => vi.useRealTimers())

describe('production-summary', () => {
  it('0-порционная PENDING-заглушка не считается заказом, но есть в «Не ответили»', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({}),
      order({
        portions: 0,
        totalPrice: 0,
        clientId: 'c2',
        locationId: 'l2',
        status: 'PENDING_CONFIRMATION',
        client: { id: 'c2', name: 'Динамик' },
        location: { id: 'l2', name: 'Склад' },
      }),
    ])

    const body = await (await handler(REQ)).json()
    const text = mockNotify.mock.calls[0][0] as string

    expect(text).toContain('Завтра: 1 заказ, 10 порций')
    expect(text).not.toContain('Динамик — 0')
    expect(text).toContain('Не ответили (1)')
    expect(text).toContain('Склад')
    expect(body.orders).toBe(1)
    expect(body.unconfirmed).toBe(1)
  })

  it('«Не ответили» без same-day точек (их завтрашний заказ создаётся завтра утром)', async () => {
    mockPrisma.order.findMany.mockResolvedValue([order({})])
    await handler(REQ)
    const where = mockPrisma.clientMealConfig.findMany.mock.calls[0][0].where
    expect(where.location).toEqual({ isActive: true, sameDayDelivery: false })
  })

  it('только заглушки → не «заказов нет», а сводка с «Не ответили»', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      order({ portions: 0, totalPrice: 0, clientId: 'c2', locationId: 'l2', status: 'PENDING_CONFIRMATION' }),
    ])
    const body = await (await handler(REQ)).json()
    const text = mockNotify.mock.calls[0][0] as string
    expect(text).toContain('Завтра: 0 заказов')
    expect(text).toContain('Не ответили (1)')
    expect(body.orders).toBe(0)
  })

  it('ничего нет → «Заказов пока нет»', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.clientMealConfig.findMany.mockResolvedValue([])
    const body = await (await handler(REQ)).json()
    expect(mockNotify.mock.calls[0][0]).toContain('Заказов пока нет')
    expect(body.total).toBe(0)
  })
})
