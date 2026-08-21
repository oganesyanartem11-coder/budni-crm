import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П2: тесты buildRouteSheetRows. Мокаем prisma.order.findMany.
 *
 * Два уровня проверки:
 *  1. Where-фильтры (client.isActive / location.isActive / status / sameDay)
 *     задаются в where и выполняются БД — проверяем, что нужные условия попали
 *     в аргументы findMany (т.е. архивный клиент / DRAFT / CANCELLED / DELIVERED
 *     не вернутся, потому что Prisma их не отдаст).
 *  2. JS-логика (резолв контакта, сортировка, index, группировка) — на реальных
 *     данных, которые «отдаёт» мок.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  buildRouteSheetRows,
  groupRouteSheetRows,
  windowLabel,
} from './build-rows'

interface DbRowOpts {
  id?: string
  clientId?: string
  locationId?: string
  status?: string
  mealType?: string
  portions?: number
  packaging?: string
  tags?: string[]
  notes?: string | null
  clientName?: string
  contactName?: string | null
  contactPhone?: string | null
  contacts?: {
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
  locationName?: string
  address?: string
  windowFrom?: string | null
  windowTo?: string | null
}

function dbRow(o: DbRowOpts = {}) {
  const clientId = o.clientId ?? 'client-1'
  const locationId = o.locationId ?? 'location-1'
  return {
    id: o.id ?? 'o1',
    clientId,
    locationId,
    mealType: o.mealType ?? 'LUNCH',
    portions: o.portions ?? 20,
    packaging: o.packaging ?? 'INDIVIDUAL',
    tags: o.tags ?? [],
    notes: o.notes ?? null,
    client: {
      name: o.clientName ?? 'Кафе',
      contactName: o.contactName ?? null,
      contactPhone: o.contactPhone ?? null,
      contacts: (o.contacts ?? []).map((contact, index) => ({
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
      name: o.locationName ?? 'Точка',
      address: o.address ?? 'ул. Ленина 1',
      deliveryWindowFrom: o.windowFrom ?? null,
      deliveryWindowTo: o.windowTo ?? null,
    },
  }
}

const DATE = new Date('2026-06-05T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildRouteSheetRows — where-фильтры', () => {
  it('фильтрует по client.isActive / location.isActive и статусам CONFIRMED/LOCKED/IN_PRODUCTION', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await buildRouteSheetRows(DATE)

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.client).toEqual({ isActive: true })
    expect(where.location.isActive).toBe(true)
    // sameDayDelivery НЕ в фильтре в обычном режиме
    expect(where.location.sameDayDelivery).toBeUndefined()
    expect(where.status).toEqual({ in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION'] })
    // DRAFT / PENDING / CANCELLED / DELIVERED / OUT_FOR_DELIVERY НЕ в списке
    expect(where.status.in).not.toContain('DRAFT')
    expect(where.status.in).not.toContain('CANCELLED')
    expect(where.status.in).not.toContain('DELIVERED')
    expect(where.status.in).not.toContain('PENDING_CONFIRMATION')
  })

  it('sameDayOnly → location.sameDayDelivery=true и статус только CONFIRMED', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await buildRouteSheetRows(DATE, { sameDayOnly: true })

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.location.sameDayDelivery).toBe(true)
    expect(where.location.isActive).toBe(true)
    expect(where.status).toEqual({ in: ['CONFIRMED'] })
  })
})

describe('buildRouteSheetRows — резолв контакта', () => {
  it('предпочитает primary-контакт целевой точки общему контакту клиента', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        contacts: [
          {
            id: 'client-wide',
            locationId: null,
            name: 'Общий контакт',
            phone: '+70000000001',
            sortOrder: 0,
          },
          {
            id: 'location-primary',
            locationId: 'location-1',
            isPrimaryForDelivery: true,
            name: 'Контакт точки',
            phone: '+70000000002',
            sortOrder: 20,
          },
        ],
      }),
    ])

    const rows = await buildRouteSheetRows(DATE)

    expect(rows[0]).toMatchObject({
      contactName: 'Контакт точки',
      contactPhone: '+70000000002',
    })
  })

  it('использует общий контакт клиента, если у точки нет контактов', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        contactName: 'Старое имя',
        contactPhone: '+70000000000',
        contacts: [{ name: 'Иван Прораб', phone: '+79991112233' }],
      }),
    ])
    const rows = await buildRouteSheetRows(DATE)
    expect(rows[0].contactName).toBe('Иван Прораб')
    expect(rows[0].contactPhone).toBe('+79991112233')
  })

  it('fallback на Client.contactName/contactPhone, если ClientContact нет', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ contactName: 'Запасной', contactPhone: '+70001112222', contacts: [] }),
    ])
    const rows = await buildRouteSheetRows(DATE)
    expect(rows[0].contactName).toBe('Запасной')
    expect(rows[0].contactPhone).toBe('+70001112222')
  })

  it('не смешивает legacy-имя с выбранным нормализованным контактом без имени', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({
        contactName: 'Имя клиента',
        contactPhone: '+70000000000',
        contacts: [{ name: null, phone: '+79995554433' }],
      }),
    ])
    const rows = await buildRouteSheetRows(DATE)
    expect(rows[0].contactName).toBeNull()
    expect(rows[0].contactPhone).toBe('+79995554433')
  })

  it('загружает полный candidate shape без take:1 для location precedence', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await buildRouteSheetRows(DATE)
    const select = mockPrisma.order.findMany.mock.calls[0][0].select
    const contacts = select.client.select.contacts
    expect(contacts.take).toBeUndefined()
    expect(contacts.orderBy).toEqual([{ sortOrder: 'asc' }, { createdAt: 'asc' }])
    expect(contacts.select).toEqual({
      id: true,
      clientId: true,
      locationId: true,
      isPrimaryForDelivery: true,
      name: true,
      phone: true,
      notes: true,
      sortOrder: true,
      createdAt: true,
    })
  })
})

describe('buildRouteSheetRows — сортировка и index', () => {
  it('сортирует по окну доставки ASC (null в конец), затем по адресу ASC; index 1-based', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ id: 'noWindow', windowFrom: null, address: 'ул. Я' }),
      dbRow({ id: 'late', windowFrom: '13:00', address: 'ул. Б' }),
      dbRow({ id: 'earlyA', windowFrom: '11:00', address: 'ул. А' }),
      dbRow({ id: 'earlyB', windowFrom: '11:00', address: 'ул. В' }),
    ])
    const rows = await buildRouteSheetRows(DATE)
    expect(rows.map((r) => r.orderId)).toEqual(['earlyA', 'earlyB', 'late', 'noWindow'])
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4])
  })
})

describe('groupRouteSheetRows — группировка по окну', () => {
  it('группирует подряд идущие строки одного окна, сохраняя порядок', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      dbRow({ id: 'a', windowFrom: '11:00', windowTo: '12:00', address: 'ул. А' }),
      dbRow({ id: 'b', windowFrom: '11:00', windowTo: '12:00', address: 'ул. Б' }),
      dbRow({ id: 'c', windowFrom: '13:00', windowTo: '14:00', address: 'ул. В' }),
      dbRow({ id: 'd', windowFrom: null, windowTo: null, address: 'ул. Г' }),
    ])
    const rows = await buildRouteSheetRows(DATE)
    const groups = groupRouteSheetRows(rows)

    expect(groups.map((g) => g.windowLabel)).toEqual(['11:00–12:00', '13:00–14:00', 'Без окна'])
    expect(groups[0].rows.map((r) => r.orderId)).toEqual(['a', 'b'])
    expect(groups[1].rows.map((r) => r.orderId)).toEqual(['c'])
    expect(groups[2].rows.map((r) => r.orderId)).toEqual(['d'])
  })
})

describe('windowLabel', () => {
  it('форматирует окно: from+to, только from, только to, ни одного', () => {
    expect(windowLabel('11:00', '12:00')).toBe('11:00–12:00')
    expect(windowLabel('11:00', null)).toBe('с 11:00')
    expect(windowLabel(null, '12:00')).toBe('до 12:00')
    expect(windowLabel(null, null)).toBe('Без окна')
  })
})
