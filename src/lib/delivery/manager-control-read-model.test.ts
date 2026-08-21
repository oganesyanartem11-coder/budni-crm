import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRouteDaysFindMany,
  mockNonHouseFindMany,
  mockRouteDayFindFirst,
  mockCouriersFindMany,
} = vi.hoisted(() => ({
  mockRouteDaysFindMany: vi.fn(),
  mockNonHouseFindMany: vi.fn(),
  mockRouteDayFindFirst: vi.fn(),
  mockCouriersFindMany: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    courierRouteDay: {
      findMany: mockRouteDaysFindMany,
      findFirst: mockRouteDayFindFirst,
    },
    courierRouteStop: { findMany: mockNonHouseFindMany },
    user: { findMany: mockCouriersFindMany },
  },
}))

import {
  ManagerDeliveryControlAccessError,
  getManagerCourierRouteDetail,
  getManagerDeliveryAnalytics,
  getManagerDeliveryControl,
} from './manager-control-read-model'

const manager = { id: 'manager-1', role: 'MANAGER' as const }
const deliveryDate = new Date('2026-08-21T00:00:00.000Z')
const now = new Date('2026-08-21T12:00:00.000Z')

function stop(over: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    routeDayId: 'route-1',
    deliveryDate,
    assignmentMode: 'IN_HOUSE',
    assignmentSource: 'MANAGER',
    assignedAt: new Date('2026-08-21T06:00:00.000Z'),
    deliveredAt: null,
    cancelledAt: null,
    completionMethod: null,
    version: 1,
    clientNameSnapshot: 'СтройПарк',
    locationNameSnapshot: 'Башня А',
    locationAddressSnapshot: 'Москва, Пресненская набережная, 8',
    contactNameSnapshot: 'Алексей',
    contactPhoneSnapshot: '+79990000000',
    contactNotesSnapshot: null,
    deliveryWindowFromSnapshot: '10:00',
    deliveryWindowToSnapshot: '10:30',
    deliveryInstructionsSnapshot: null,
    geofenceEnabledSnapshot: true,
    geofenceRadiusMSnapshot: 1_000,
    orders: [{
      id: 'order-1',
      status: 'OUT_FOR_DELIVERY',
      mealType: 'LUNCH',
      portions: 10,
      packaging: 'INDIVIDUAL',
      tags: [],
      notes: null,
    }],
    deliveryGeoAttempts: [],
    deliveryOverrideRequests: [],
    ...over,
  }
}

function routeDay(over: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    courierId: 'courier-1',
    courierNameSnapshot: 'Иван Петров',
    deliveryDate,
    startedAt: new Date('2026-08-21T05:30:00.000Z'),
    completedAt: null,
    routeChangedAt: new Date('2026-08-21T06:30:00.000Z'),
    stops: [stop()],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRouteDaysFindMany.mockResolvedValue([])
  mockNonHouseFindMany.mockResolvedValue([])
  mockRouteDayFindFirst.mockResolvedValue(null)
  mockCouriersFindMany.mockResolvedValue([])
})

describe('getManagerDeliveryControl', () => {
  it('denies courier and chef actors before any query', async () => {
    await expect(getManagerDeliveryControl(
      { id: 'courier-1', role: 'COURIER' },
      deliveryDate,
      now,
    )).rejects.toBeInstanceOf(ManagerDeliveryControlAccessError)

    expect(mockRouteDaysFindMany).not.toHaveBeenCalled()
    expect(mockNonHouseFindMany).not.toHaveBeenCalled()
  })

  it('answers the today control questions from stops, not orders', async () => {
    mockRouteDaysFindMany.mockResolvedValue([
      routeDay({
        stops: [
          stop({
            id: 'delivered',
            deliveredAt: new Date('2026-08-21T08:00:00.000Z'),
            completionMethod: 'GEOFENCE',
          }),
          stop({
            id: 'late',
            deliveryWindowFromSnapshot: '08:00',
            deliveryWindowToSnapshot: '08:30',
            deliveryGeoAttempts: [{
              id: 'geo-1',
              result: 'OUTSIDE_GEOFENCE',
              distanceM: 1_250,
              accuracyM: 30,
              receivedAt: new Date('2026-08-21T11:50:00.000Z'),
            }],
          }),
        ],
      }),
      routeDay({
        id: 'route-2',
        courierId: 'courier-2',
        courierNameSnapshot: 'Анна Смирнова',
        stops: [stop({
          id: 'new-stop',
          routeDayId: 'route-2',
          assignedAt: new Date('2026-08-21T07:00:00.000Z'),
          deliveryWindowFromSnapshot: null,
          deliveryWindowToSnapshot: null,
          deliveryOverrideRequests: [{
            id: 'override-1',
            geoAttemptId: 'geo-override',
            status: 'PENDING',
            comment: 'Охрана не пускает',
            expiresAt: new Date('2026-08-21T12:15:00.000Z'),
            createdAt: new Date('2026-08-21T11:55:00.000Z'),
            resolvedAt: null,
            resolutionComment: null,
          }],
        })],
      }),
    ])
    mockNonHouseFindMany.mockResolvedValue([
      stop({
        id: 'external',
        routeDayId: null,
        assignmentMode: 'EXTERNAL',
        deliveryWindowFromSnapshot: null,
        deliveryWindowToSnapshot: null,
      }),
      stop({
        id: 'unassigned',
        routeDayId: null,
        assignmentMode: 'UNASSIGNED',
        deliveryWindowFromSnapshot: null,
        deliveryWindowToSnapshot: null,
      }),
    ])

    const result = await getManagerDeliveryControl(manager, deliveryDate, now)

    expect(mockRouteDaysFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deliveryDate },
    }))
    expect(result.summary).toEqual({
      workingCouriers: 2,
      totalStops: 5,
      deliveredStops: 1,
      activeLateStops: 1,
      externalStops: 1,
      unassignedStops: 1,
      pendingOverrides: 1,
    })
    expect(result.couriers[0]).toMatchObject({
      courierName: 'Иван Петров',
      totalStops: 2,
      deliveredStops: 1,
      activeLateStops: 1,
      lastAction: { kind: 'GPS_CHECK', stopId: 'late' },
    })
    expect(result.couriers[1]).toMatchObject({
      courierName: 'Анна Смирнова',
      newStops: 1,
      pendingOverrides: 1,
    })
  })
})

describe('getManagerCourierRouteDetail', () => {
  it('opens the first pending override by default so the manager can act immediately', async () => {
    mockRouteDayFindFirst.mockResolvedValue(routeDay({
      stops: [
        stop({ id: 'ordinary-stop', deliveryWindowToSnapshot: '08:00' }),
        stop({
          id: 'pending-stop',
          deliveryWindowToSnapshot: '11:00',
          deliveryGeoAttempts: [{
            id: 'geo-pending',
            result: 'OUTSIDE_GEOFENCE',
            distanceM: 1_250,
            accuracyM: 30,
            receivedAt: new Date('2026-08-21T11:50:00.000Z'),
          }],
          deliveryOverrideRequests: [{
            id: 'override-pending',
            geoAttemptId: 'geo-pending',
            status: 'PENDING',
            comment: 'Охрана не пускает',
            expiresAt: new Date('2026-08-21T12:15:00.000Z'),
            createdAt: new Date('2026-08-21T11:55:00.000Z'),
            resolvedAt: null,
            resolutionComment: null,
          }],
        }),
      ],
    }))

    const result = await getManagerCourierRouteDetail(manager, 'route-1', null, now)

    expect(result?.selectedStop?.id).toBe('pending-stop')
    expect(result?.selectedStop?.timeline[0]?.detail).toBe('Охрана не пускает')
    expect(result?.selectedStop?.timeline[1]?.detail).toBe('Вне геозоны · 1250 м')
  })

  it('never selects a foreign stop id supplied by the URL', async () => {
    mockRouteDayFindFirst.mockResolvedValue(routeDay({ stops: [stop({ id: 'own-stop' })] }))
    mockCouriersFindMany.mockResolvedValue([
      { id: 'courier-1', name: 'Иван Петров' },
      { id: 'courier-2', name: 'Анна Смирнова' },
    ])

    const result = await getManagerCourierRouteDetail(
      manager,
      'route-1',
      'foreign-stop',
      now,
    )

    expect(mockRouteDayFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'route-1' },
    }))
    expect(result?.selectedStop?.id).toBe('own-stop')
    expect(result?.couriers).toHaveLength(2)
  })

  it('denies a courier before route and courier-list queries', async () => {
    await expect(getManagerCourierRouteDetail(
      { id: 'courier-1', role: 'COURIER' },
      'route-1',
      null,
      now,
    )).rejects.toBeInstanceOf(ManagerDeliveryControlAccessError)

    expect(mockRouteDayFindFirst).not.toHaveBeenCalled()
    expect(mockCouriersFindMany).not.toHaveBeenCalled()
  })
})

describe('getManagerDeliveryAnalytics', () => {
  it('queries only the requested date range and returns stop-based metrics', async () => {
    const from = new Date('2026-08-15T00:00:00.000Z')
    const to = new Date('2026-08-21T00:00:00.000Z')
    mockNonHouseFindMany.mockResolvedValue([{
      id: 'delivered-stop',
      deliveryDate,
      assignmentMode: 'EXTERNAL',
      cancelledAt: null,
      deliveredAt: new Date('2026-08-21T07:00:00.000Z'),
      deliveryWindowToSnapshot: '10:00',
      completionMethod: 'MANAGER_DIRECT',
      routeDay: null,
    }])

    const result = await getManagerDeliveryAnalytics(manager, { from, to })

    expect(mockNonHouseFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deliveryDate: { gte: from, lte: to },
        cancelledAt: null,
      },
    }))
    expect(result.overall).toMatchObject({
      physicalDeliveries: 1,
      onTime: 1,
      late: 0,
    })
  })

  it('denies non-managers before the analytics query', async () => {
    await expect(getManagerDeliveryAnalytics(
      { id: 'chef-1', role: 'CHEF' },
      { from: deliveryDate, to: deliveryDate },
    )).rejects.toBeInstanceOf(ManagerDeliveryControlAccessError)
    expect(mockNonHouseFindMany).not.toHaveBeenCalled()
  })
})
