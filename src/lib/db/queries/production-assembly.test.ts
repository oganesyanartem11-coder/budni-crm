import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindMany, mockGetCourierAssignmentOrders } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockGetCourierAssignmentOrders: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    order: { findMany: mockFindMany },
    menuCycle: { findFirst: vi.fn() },
  },
}))
vi.mock('@/lib/db/queries/delivery-revenue', () => ({
  sumDeliveryRevenue: vi.fn(),
}))
vi.mock('@/lib/orders/courier-queries', () => ({
  getCourierAssignmentOrders: mockGetCourierAssignmentOrders,
}))

import { getAssemblyOrders } from './production'

const DATE = new Date('2026-08-07T00:00:00.000Z')

function sharedRow(over: Record<string, unknown> = {}) {
  return {
    orderId: 'order_1',
    clientId: 'client_1',
    clientName: 'Клиент А',
    clientContactName: 'Контакт',
    clientContactPhone: '+70000000000',
    locationId: 'loc_1',
    locationName: 'Точка А',
    locationAddress: 'Адрес А',
    deliveryWindowFrom: '09:00',
    deliveryWindowTo: '10:00',
    mealType: 'LUNCH',
    portions: 10,
    status: 'CONFIRMED',
    assignedCourierId: 'courier_anna',
    assignedCourier: { id: 'courier_anna', name: 'Анна' },
    assignmentMode: 'IN_HOUSE',
    courierLabel: 'Анна',
    packaging: 'INDIVIDUAL',
    tags: ['важно'],
    notes: 'Позвонить',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Старый inline-query shape: RED до перевода assembly на shared query.
  mockFindMany.mockResolvedValue([{
    id: 'legacy',
    client: { name: 'Legacy', contactPhone: null },
    location: {
      name: 'Legacy',
      address: 'Legacy',
      packaging: 'INDIVIDUAL',
      tags: [],
      deliveryWindowFrom: null,
      deliveryWindowTo: null,
    },
    mealType: 'LUNCH',
    portions: 1,
    notes: null,
    status: 'CONFIRMED',
  }])
})

describe('getAssemblyOrders courier serialization', () => {
  it('сохраняет row contract и добавляет assigned/InDrive для разных курьеров', async () => {
    mockGetCourierAssignmentOrders.mockResolvedValue([
      sharedRow(),
      sharedRow({
        orderId: 'order_2',
        clientName: 'Клиент Б',
        locationId: 'loc_2',
        locationName: 'Точка Б',
        assignedCourierId: 'courier_boris',
        assignedCourier: { id: 'courier_boris', name: 'Борис' },
        assignmentMode: 'IN_HOUSE',
        courierLabel: 'Борис',
        deliveryWindowFrom: '10:00',
      }),
      sharedRow({
        orderId: 'order_3',
        clientName: 'Клиент В',
        locationId: 'loc_3',
        locationName: 'Точка В',
        assignedCourierId: null,
        assignedCourier: null,
        assignmentMode: 'EXTERNAL',
        courierLabel: 'InDrive',
        deliveryWindowFrom: '11:00',
      }),
    ])

    const rows = await getAssemblyOrders(DATE)

    expect(mockGetCourierAssignmentOrders).toHaveBeenCalledWith(DATE)
    expect(rows.map((row) => ({
      orderId: row.orderId,
      assignedCourierId: row.assignedCourierId,
      courierName: row.courierName,
      courierLabel: row.courierLabel,
    }))).toEqual([
      {
        orderId: 'order_1',
        assignedCourierId: 'courier_anna',
        courierName: 'Анна',
        courierLabel: 'Анна',
      },
      {
        orderId: 'order_2',
        assignedCourierId: 'courier_boris',
        courierName: 'Борис',
        courierLabel: 'Борис',
      },
      {
        orderId: 'order_3',
        assignedCourierId: null,
        courierName: null,
        courierLabel: 'InDrive',
      },
    ])
    expect(rows[0]).toEqual(expect.objectContaining({
      clientName: 'Клиент А',
      clientContactPhone: '+70000000000',
      locationName: 'Точка А',
      locationAddress: 'Адрес А',
      mealType: 'LUNCH',
      portions: 10,
      packaging: 'INDIVIDUAL',
      tags: ['важно'],
      notes: 'Позвонить',
      deliveryWindowFrom: '09:00',
      deliveryWindowTo: '10:00',
      status: 'CONFIRMED',
    }))
  })
})
