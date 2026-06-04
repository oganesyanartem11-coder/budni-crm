import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * П5: тесты выборок заказов без курьера. Мокаем prisma; mskMidnightUtc —
 * реальная (чистая дата-функция). Время фиксируем через vi.setSystemTime,
 * чтобы «завтра/сегодня МСК» и окно «через час» были детерминированными.
 *
 * Фильтрация по assignedCourierId/courierMissingNotifiedAt/status задаётся в
 * where и выполняется БД — в unit-тесте проверяем, что эти условия попадают в
 * аргументы findMany (т.е. заказ с курьером/уже уведомлённый/CANCELLED не
 * вернётся, потому что Prisma его не отдаст). А вот оконный фильтр
 * hour-before-window — это пост-обработка в JS, её проверяем на реальных данных.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  getOrdersWithoutCourierTomorrow,
  getOrdersForHourBeforeWindow,
  markCourierNotified,
} from './courier-queries'

// Decimal-подобный totalPrice.
function decimal(n: number) {
  return { toNumber: () => n }
}

function dbRow(over: Partial<{
  id: string
  mealType: string
  portions: number
  totalPrice: number
  clientName: string
  contactPhone: string | null
  locationName: string
  address: string
  windowFrom: string | null
  windowTo: string | null
  assignedCourierId: string | null
}> = {}) {
  return {
    id: over.id ?? 'o1',
    mealType: over.mealType ?? 'LUNCH',
    portions: over.portions ?? 20,
    totalPrice: decimal(over.totalPrice ?? 10000),
    client: { name: over.clientName ?? 'Кафе', contactPhone: over.contactPhone ?? '+7900' },
    location: {
      name: over.locationName ?? 'Точка',
      address: over.address ?? 'ул. Ленина 1',
      // 'windowFrom' in over → уважаем явный null; иначе дефолт '12:00'.
      deliveryWindowFrom: 'windowFrom' in over ? (over.windowFrom ?? null) : '12:00',
      deliveryWindowTo: 'windowTo' in over ? (over.windowTo ?? null) : '13:00',
      assignedCourierId: over.assignedCourierId ?? null,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getOrdersWithoutCourierTomorrow', () => {
  it('where: status активный, нет курьера, не уведомлён; deliveryDate=завтра МСК', async () => {
    // 2026-06-04 10:00 UTC = 13:00 МСК. Завтра МСК = 2026-06-05 → UTC-полночь.
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([dbRow()])

    await getOrdersWithoutCourierTomorrow()

    const arg = mockPrisma.order.findMany.mock.calls[0][0]
    expect(arg.where.status).toEqual({ in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION'] })
    expect(arg.where.courierMissingNotifiedAt).toBeNull()
    expect(arg.where.location).toEqual({ assignedCourierId: null })
    expect(arg.where.deliveryDate).toEqual(new Date('2026-06-05T00:00:00.000Z'))
  })

  it('маппинг DTO: Decimal totalPrice → Number; поля клиента/точки прокинуты', async () => {
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        id: 'ox',
        clientName: 'Банк',
        contactPhone: '+7123',
        locationName: 'Офис',
        address: 'Тверская 7',
        windowFrom: '11:00',
        windowTo: '11:30',
        portions: 33,
        totalPrice: 16500,
      }),
    ])

    const res = await getOrdersWithoutCourierTomorrow()
    expect(res).toHaveLength(1)
    expect(res[0]).toEqual({
      orderId: 'ox',
      clientName: 'Банк',
      clientContactPhone: '+7123',
      locationName: 'Офис',
      locationAddress: 'Тверская 7',
      deliveryWindowFrom: '11:00',
      deliveryWindowTo: '11:30',
      mealType: 'LUNCH',
      portions: 33,
      totalPrice: 16500,
    })
    expect(typeof res[0].totalPrice).toBe('number')
  })

  it('заказ с окном=null включается (для вечернего обзора)', async () => {
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ windowFrom: null, windowTo: null }),
    ])

    const res = await getOrdersWithoutCourierTomorrow()
    expect(res).toHaveLength(1)
    expect(res[0].deliveryWindowFrom).toBeNull()
  })

  it('assignedCourierId=null → попадает; курьер назначен → БД не вернёт (where фильтрует)', async () => {
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    // Имитируем поведение БД: заказ без курьера в результате есть.
    mockPrisma.order.findMany.mockResolvedValue([dbRow({ assignedCourierId: null })])
    const res1 = await getOrdersWithoutCourierTomorrow()
    expect(res1).toHaveLength(1)
    // А с назначенным курьером БД отдаёт пусто (where { location: { assignedCourierId: null } }).
    mockPrisma.order.findMany.mockResolvedValue([])
    const res2 = await getOrdersWithoutCourierTomorrow()
    expect(res2).toHaveLength(0)
  })
})

describe('getOrdersForHourBeforeWindow', () => {
  // Фиксированный «сейчас»: 2026-06-04 08:00 UTC = 11:00 МСК. Сегодня МСК = 2026-06-04.
  // Окно МСК "HH:mm" → UTC (HH-3):mm на 2026-06-04.
  const NOW = new Date('2026-06-04T08:00:00.000Z')

  beforeEach(() => {
    vi.setSystemTime(NOW)
  })

  it('where: только заказы с deliveryWindowFrom != null, сегодня МСК, без курьера, не уведомлён', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await getOrdersForHourBeforeWindow(NOW)

    const arg = mockPrisma.order.findMany.mock.calls[0][0]
    expect(arg.where.deliveryDate).toEqual(new Date('2026-06-04T00:00:00.000Z'))
    expect(arg.where.status).toEqual({ in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION'] })
    expect(arg.where.courierMissingNotifiedAt).toBeNull()
    expect(arg.where.location).toEqual({
      assignedCourierId: null,
      deliveryWindowFrom: { not: null },
    })
  })

  it('окно через 70 мин → попадает (now=11:00 МСК, окно 12:10 = +70м)', async () => {
    // 11:00 + 70м = 12:10 МСК.
    mockPrisma.order.findMany.mockResolvedValue([dbRow({ id: 'in', windowFrom: '12:10' })])
    const res = await getOrdersForHourBeforeWindow(NOW)
    expect(res.map((r) => r.orderId)).toEqual(['in'])
  })

  it('окно через 30 мин → НЕ попадает (раньше нижней границы +50м)', async () => {
    // 11:00 + 30м = 11:30 МСК.
    mockPrisma.order.findMany.mockResolvedValue([dbRow({ id: 'soon', windowFrom: '11:30' })])
    const res = await getOrdersForHourBeforeWindow(NOW)
    expect(res).toHaveLength(0)
  })

  it('окно через 120 мин → НЕ попадает (позже верхней границы +90м)', async () => {
    // 11:00 + 120м = 13:00 МСК.
    mockPrisma.order.findMany.mockResolvedValue([dbRow({ id: 'far', windowFrom: '13:00' })])
    const res = await getOrdersForHourBeforeWindow(NOW)
    expect(res).toHaveLength(0)
  })

  it('границы включительно: ровно +50м и +90м попадают', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ id: 'lo', windowFrom: '11:50' }), // +50м
      dbRow({ id: 'hi', windowFrom: '12:30' }), // +90м
    ])
    const res = await getOrdersForHourBeforeWindow(NOW)
    expect(res.map((r) => r.orderId).sort()).toEqual(['hi', 'lo'])
  })

  it('несколько заказов: только попавшие в окно возвращаются', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ id: 'in1', windowFrom: '12:00' }), // +60м ✓
      dbRow({ id: 'early', windowFrom: '11:20' }), // +20м ✗
      dbRow({ id: 'in2', windowFrom: '12:15' }), // +75м ✓
      dbRow({ id: 'late', windowFrom: '14:00' }), // +180м ✗
    ])
    const res = await getOrdersForHourBeforeWindow(NOW)
    expect(res.map((r) => r.orderId).sort()).toEqual(['in1', 'in2'])
  })
})

describe('markCourierNotified', () => {
  it('updateMany с where courierMissingNotifiedAt:null (анти-гонка), возвращает count', async () => {
    mockPrisma.order.updateMany.mockResolvedValue({ count: 3 })
    const n = await markCourierNotified(['a', 'b', 'c'])

    expect(n).toBe(3)
    const arg = mockPrisma.order.updateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ id: { in: ['a', 'b', 'c'] }, courierMissingNotifiedAt: null })
    expect(arg.data.courierMissingNotifiedAt).toBeInstanceOf(Date)
  })

  it('пустой массив → updateMany не вызывается, count 0', async () => {
    const n = await markCourierNotified([])
    expect(n).toBe(0)
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
  })
})
