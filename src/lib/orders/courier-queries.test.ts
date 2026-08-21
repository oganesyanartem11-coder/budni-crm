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

const { mockPrisma, mockEnsureRouteStops } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
  },
  mockEnsureRouteStops: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/delivery/route-materializer', () => ({
  ensureCourierRouteStopsForDate: mockEnsureRouteStops,
}))

import {
  getCourierAssignmentOrders,
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
  clientId: string
  locationId: string
  mealType: string
  portions: number
  totalPrice: number
  clientName: string
  contactName: string | null
  contactPhone: string | null
  contacts: {
    id?: string
    clientId?: string
    locationId?: string | null
    isPrimaryForDelivery?: boolean
    name: string | null
    phone: string
    notes?: string | null
    sortOrder?: number
    createdAt?: Date
  }[]
  locationName: string
  address: string
  windowFrom: string | null
  windowTo: string | null
  assignedCourierId: string | null
  assignedCourier: {
    id: string
    name: string
    role: string
    isActive: boolean
  } | null
  routeStop: {
    assignmentMode: 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'
    clientNameSnapshot: string
    locationNameSnapshot: string
    locationAddressSnapshot: string
    contactNameSnapshot: string | null
    contactPhoneSnapshot: string | null
    deliveryWindowFromSnapshot: string | null
    deliveryWindowToSnapshot: string | null
    routeDay: {
      courierId: string
      courierNameSnapshot: string
    } | null
  } | null
}> = {}) {
  const clientId = over.clientId ?? 'client_1'
  const locationId = over.locationId ?? 'loc_1'
  return {
    id: over.id ?? 'o1',
    clientId,
    locationId,
    mealType: over.mealType ?? 'LUNCH',
    status: 'CONFIRMED',
    portions: over.portions ?? 20,
    totalPrice: decimal(over.totalPrice ?? 10000),
    notes: 'Позвонить заранее',
    client: {
      name: over.clientName ?? 'Кафе',
      contactName: 'contactName' in over ? (over.contactName ?? null) : 'Запасной контакт',
      contactPhone: 'contactPhone' in over ? (over.contactPhone ?? null) : '+7900',
      contacts: (over.contacts ?? []).map((contact, index) => ({
        id: contact.id ?? `contact-${index + 1}`,
        clientId: contact.clientId ?? clientId,
        locationId: contact.locationId ?? null,
        isPrimaryForDelivery: contact.isPrimaryForDelivery ?? false,
        name: contact.name,
        phone: contact.phone,
        notes: contact.notes ?? null,
        sortOrder: contact.sortOrder ?? index,
        createdAt: contact.createdAt ?? new Date('2026-06-01T09:00:00.000Z'),
      })),
    },
    location: {
      name: over.locationName ?? 'Точка',
      address: over.address ?? 'ул. Ленина 1',
      packaging: 'INDIVIDUAL',
      tags: ['термосумка'],
      // 'windowFrom' in over → уважаем явный null; иначе дефолт '12:00'.
      deliveryWindowFrom: 'windowFrom' in over ? (over.windowFrom ?? null) : '12:00',
      deliveryWindowTo: 'windowTo' in over ? (over.windowTo ?? null) : '13:00',
      assignedCourierId: over.assignedCourierId ?? null,
      assignedCourier: over.assignedCourier ?? null,
    },
    routeStop: 'routeStop' in over
      ? over.routeStop
      : {
          assignmentMode: 'EXTERNAL',
          clientNameSnapshot: over.clientName ?? 'Кафе',
          locationNameSnapshot: over.locationName ?? 'Точка',
          locationAddressSnapshot: over.address ?? 'ул. Ленина 1',
          contactNameSnapshot: null,
          contactPhoneSnapshot: over.contactPhone ?? '+7900',
          deliveryWindowFromSnapshot: 'windowFrom' in over ? (over.windowFrom ?? null) : '12:00',
          deliveryWindowToSnapshot: 'windowTo' in over ? (over.windowTo ?? null) : '13:00',
          routeDay: null,
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
  it('uses the primary contact of the order location instead of the legacy phone', async () => {
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        contactPhone: '+70000000000',
        contacts: [
          {
            id: 'client-wide',
            locationId: null,
            name: 'Общий',
            phone: '+71111111111',
            sortOrder: 0,
          },
          {
            id: 'location-primary',
            locationId: 'loc_1',
            isPrimaryForDelivery: true,
            name: 'Контакт точки',
            phone: '+72222222222',
            sortOrder: 20,
          },
        ],
      }),
    ])

    const [result] = await getOrdersWithoutCourierTomorrow()

    expect(result.clientContactPhone).toBe('+72222222222')
  })

  it('where: status активный, daily EXTERNAL/UNASSIGNED, не уведомлён; deliveryDate=завтра МСК', async () => {
    // 2026-06-04 10:00 UTC = 13:00 МСК. Завтра МСК = 2026-06-05 → UTC-полночь.
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    mockPrisma.order.findMany.mockResolvedValue([dbRow()])

    await getOrdersWithoutCourierTomorrow()

    const arg = mockPrisma.order.findMany.mock.calls[0][0]
    expect(arg.where.status).toEqual({
      in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
    })
    expect(arg.where.courierMissingNotifiedAt).toBeNull()
    expect(arg.where.routeStop).toEqual({
      assignmentMode: { in: ['EXTERNAL', 'UNASSIGNED'] },
    })
    expect(arg.where.deliveryDate).toEqual(new Date('2026-06-05T00:00:00.000Z'))
    expect(mockEnsureRouteStops).toHaveBeenCalledWith(
      new Date('2026-06-05T00:00:00.000Z'),
    )
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

  it('daily EXTERNAL/UNASSIGNED попадает; daily IN_HOUSE БД не вернёт', async () => {
    vi.setSystemTime(new Date('2026-06-04T10:00:00.000Z'))
    // Имитируем поведение БД: daily external/unassigned в результате есть.
    mockPrisma.order.findMany.mockResolvedValue([dbRow({ assignedCourierId: null })])
    const res1 = await getOrdersWithoutCourierTomorrow()
    expect(res1).toHaveLength(1)
    // А daily IN_HOUSE БД отдаёт пусто по relation-фильтру routeStop.
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

  it('where: окно задано, сегодня МСК, daily EXTERNAL/UNASSIGNED, не уведомлён', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await getOrdersForHourBeforeWindow(NOW)

    const arg = mockPrisma.order.findMany.mock.calls[0][0]
    expect(arg.where.deliveryDate).toEqual(new Date('2026-06-04T00:00:00.000Z'))
    expect(arg.where.status).toEqual({
      in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
    })
    expect(arg.where.courierMissingNotifiedAt).toBeNull()
    expect(arg.where.location).toEqual({
      deliveryWindowFrom: { not: null },
    })
    expect(arg.where.routeStop).toEqual({
      assignmentMode: { in: ['EXTERNAL', 'UNASSIGNED'] },
    })
    expect(mockEnsureRouteStops).toHaveBeenCalledWith(
      new Date('2026-06-04T00:00:00.000Z'),
    )
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

describe('getCourierAssignmentOrders', () => {
  const DELIVERY_DATE = new Date('2026-08-07T00:00:00.000Z')

  it('normalizes once and reuses the same exact MSK @db.Date for materialize and read', async () => {
    const boundaryMoment = new Date('2026-08-10T21:30:00.000Z')
    const exactDate = new Date('2026-08-11T00:00:00.000Z')
    mockPrisma.order.findMany.mockResolvedValue([dbRow()])

    await getCourierAssignmentOrders(boundaryMoment)

    expect(mockEnsureRouteStops).toHaveBeenCalledWith(exactDate)
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual(exactDate)
  })

  it('materializes exact @db.Date and uses only the persisted daily assignment/snapshots', async () => {
    const row = dbRow({
      assignedCourierId: 'location-default-courier',
      assignedCourier: {
        id: 'location-default-courier',
        name: 'Не дневной курьер',
        role: 'COURIER',
        isActive: true,
      },
      routeStop: {
        assignmentMode: 'IN_HOUSE',
        clientNameSnapshot: 'Кафе snapshot',
        locationNameSnapshot: 'Точка snapshot',
        locationAddressSnapshot: 'Адрес snapshot',
        contactNameSnapshot: 'Встречающий snapshot',
        contactPhoneSnapshot: '+79991112233',
        deliveryWindowFromSnapshot: '09:00',
        deliveryWindowToSnapshot: '10:00',
        routeDay: {
          courierId: 'daily-courier',
          courierNameSnapshot: 'Анна Дневная',
        },
      },
    })
    mockPrisma.order.findMany.mockResolvedValue([row])

    const result = await getCourierAssignmentOrders(DELIVERY_DATE)

    expect(mockEnsureRouteStops).toHaveBeenCalledWith(DELIVERY_DATE)
    const query = mockPrisma.order.findMany.mock.calls[0][0]
    expect(query.where).toEqual({
      deliveryDate: DELIVERY_DATE,
      status: { in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'] },
    })
    expect(query.select.routeStop).toEqual({
      select: expect.objectContaining({
        assignmentMode: true,
        routeDay: {
          select: { courierId: true, courierNameSnapshot: true },
        },
      }),
    })
    expect(query.select.delivery).toBeUndefined()
    expect(result[0]).toEqual(expect.objectContaining({
      orderId: 'o1',
      clientId: 'client_1',
      clientName: 'Кафе snapshot',
      clientContactName: 'Встречающий snapshot',
      clientContactPhone: '+79991112233',
      locationId: 'loc_1',
      locationName: 'Точка snapshot',
      assignedCourierId: 'daily-courier',
      assignedCourier: { id: 'daily-courier', name: 'Анна Дневная' },
      assignmentMode: 'IN_HOUSE',
      courierLabel: 'Анна Дневная',
      status: 'CONFIRMED',
      packaging: 'INDIVIDUAL',
      tags: ['термосумка'],
      notes: 'Позвонить заранее',
    }))
  })

  it.each([
    { mode: 'EXTERNAL' as const, label: 'InDrive' },
    { mode: 'UNASSIGNED' as const, label: 'Не назначено' },
  ])('distinguishes daily $mode from location defaults', async ({ mode, label }) => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        assignedCourierId: 'location-default-courier',
        routeStop: {
          assignmentMode: mode,
          clientNameSnapshot: 'Кафе',
          locationNameSnapshot: 'Точка',
          locationAddressSnapshot: 'Адрес',
          contactNameSnapshot: null,
          contactPhoneSnapshot: null,
          deliveryWindowFromSnapshot: null,
          deliveryWindowToSnapshot: null,
          routeDay: null,
        },
      }),
    ])

    const result = await getCourierAssignmentOrders(DELIVERY_DATE)

    expect(result[0].assignedCourierId).toBeNull()
    expect(result[0].assignedCourier).toBeNull()
    expect(result[0].assignmentMode).toBe(mode)
    expect(result[0].courierLabel).toBe(label)
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
