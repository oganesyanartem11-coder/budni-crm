import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRouteFindFirst, mockStopFindFirst } = vi.hoisted(() => ({
  mockRouteFindFirst: vi.fn(),
  mockStopFindFirst: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    courierRouteDay: { findFirst: mockRouteFindFirst },
    courierRouteStop: { findFirst: mockStopFindFirst },
  },
}))

import {
  CourierRouteReadAccessError,
  getOwnCourierRouteDay,
  getOwnCourierRouteStop,
} from './courier-route-read-model'

const deliveryDate = new Date('2026-08-21T00:00:00.000Z')
const now = new Date('2026-08-21T07:30:00.000Z')
const actor = { id: 'courier-own', role: 'COURIER' as const }

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    status: 'CONFIRMED',
    mealType: 'LUNCH',
    portions: 10,
    packaging: 'INDIVIDUAL',
    tags: ['Без свинины'],
    notes: 'Позвонить заранее',
    ...over,
  }
}

function stop(over: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    routeDayId: 'route-1',
    deliveryDate,
    clientId: 'client-1',
    locationId: 'location-1',
    assignmentMode: 'IN_HOUSE',
    clientNameSnapshot: 'СтальСтройМонтаж',
    locationNameSnapshot: 'Аэропорт',
    locationAddressSnapshot: 'ул. Аэропортовская, 12',
    contactNameSnapshot: 'Анна',
    contactPhoneSnapshot: '+79991234567',
    contactNotesSnapshot: 'Встретит у шлагбаума',
    deliveryWindowFromSnapshot: '10:00',
    deliveryWindowToSnapshot: '11:00',
    deliveryInstructionsSnapshot: 'Въезд через вторые ворота',
    latitudeSnapshot: 55.75,
    longitudeSnapshot: 37.61,
    geofenceRadiusMSnapshot: 1_000,
    geofenceEnabledSnapshot: true,
    assignedAt: new Date('2026-08-21T05:00:00.000Z'),
    deliveredAt: null,
    completionMethod: null,
    cancelledAt: null,
    version: 1,
    orders: [order()],
    deliveryGeoAttempts: [],
    deliveryOverrideRequests: [],
    ...over,
  }
}

describe('getOwnCourierRouteDay', () => {
  beforeEach(() => {
    mockRouteFindFirst.mockReset()
    mockStopFindFirst.mockReset()
    mockRouteFindFirst.mockResolvedValue(null)
    mockStopFindFirst.mockResolvedValue(null)
  })

  it('filters the route by the authenticated courier and exact delivery date', async () => {
    await getOwnCourierRouteDay(actor, deliveryDate, now)

    expect(mockRouteFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { courierId: 'courier-own', deliveryDate },
    }))
  })

  it('denies non-couriers before any route query', async () => {
    await expect(getOwnCourierRouteDay(
      { id: 'chef-1', role: 'CHEF' },
      deliveryDate,
      now,
    )).rejects.toBeInstanceOf(CourierRouteReadAccessError)

    expect(mockRouteFindFirst).not.toHaveBeenCalled()
  })

  it('builds next, remaining, delivered, new-stop and progress groups from physical stops', async () => {
    mockRouteFindFirst.mockResolvedValue({
      id: 'route-1',
      courierId: 'courier-own',
      courierNameSnapshot: 'Иван Петров',
      deliveryDate,
      startedAt: new Date('2026-08-21T05:30:00.000Z'),
      completedAt: null,
      routeChangedAt: new Date('2026-08-21T06:00:00.000Z'),
      stops: [
        stop({
          id: 'new-stop',
          assignedAt: new Date('2026-08-21T06:00:00.000Z'),
          deliveryWindowFromSnapshot: '10:00',
          orders: [order({ id: 'order-new', portions: 7 })],
        }),
        stop({
          id: 'delivered-stop',
          deliveredAt: new Date('2026-08-21T06:30:00.000Z'),
          completionMethod: 'GEOFENCE',
          deliveryWindowFromSnapshot: '08:00',
          orders: [order({ id: 'order-delivered', status: 'DELIVERED', portions: 4 })],
        }),
        stop({
          id: 'next-stop',
          deliveryWindowFromSnapshot: '09:00',
          orders: [order({ id: 'order-next', portions: 11 })],
        }),
        stop({
          id: 'cancelled-stop',
          cancelledAt: new Date('2026-08-21T05:45:00.000Z'),
          orders: [order({ id: 'order-cancelled', status: 'CANCELLED', portions: 99 })],
        }),
      ],
    })

    const route = await getOwnCourierRouteDay(actor, deliveryDate, now)

    expect(route).toMatchObject({
      id: 'route-1',
      state: 'IN_PROGRESS',
      totalStops: 3,
      deliveredStops: 1,
      remainingStops: 2,
      totalPortions: 22,
      deliveredPortions: 4,
      nextStop: { id: 'next-stop', state: 'PLANNED' },
      otherStops: [{ id: 'new-stop', state: 'NEW' }],
      completedStops: [{ id: 'delivered-stop', state: 'DELIVERED' }],
      newStops: [{ id: 'new-stop' }],
      hasRouteChanges: true,
    })
  })
})

describe('getOwnCourierRouteStop', () => {
  beforeEach(() => {
    mockRouteFindFirst.mockReset()
    mockStopFindFirst.mockReset()
    mockStopFindFirst.mockResolvedValue(null)
  })

  it('uses an own-route relational filter and denies a foreign or missing stop', async () => {
    await expect(getOwnCourierRouteStop(actor, 'foreign-stop', now))
      .rejects.toBeInstanceOf(CourierRouteReadAccessError)

    expect(mockStopFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'foreign-stop',
        assignmentMode: 'IN_HOUSE',
        routeDay: { courierId: 'courier-own' },
      },
    }))
  })

  it('returns the full stop plus computed expired override without mutating it', async () => {
    mockStopFindFirst.mockResolvedValue(stop({
      routeDay: {
        id: 'route-1',
        courierId: 'courier-own',
        startedAt: new Date('2026-08-21T05:30:00.000Z'),
        completedAt: null,
      },
      deliveryGeoAttempts: [{
        id: 'attempt-1',
        result: 'LOW_ACCURACY',
        distanceM: 320,
        accuracyM: 145,
        createdAt: new Date('2026-08-21T07:20:00.000Z'),
        overrideRequest: { id: 'override-1' },
      }],
      deliveryOverrideRequests: [{
        id: 'override-1',
        status: 'PENDING',
        expiresAt: new Date('2026-08-21T07:29:00.000Z'),
        createdAt: new Date('2026-08-21T07:20:00.000Z'),
        resolutionComment: null,
      }],
    }))

    const result = await getOwnCourierRouteStop(actor, 'stop-1', now)

    expect(result).toMatchObject({
      id: 'stop-1',
      clientName: 'СтальСтройМонтаж',
      locationName: 'Аэропорт',
      totalPortions: 10,
      geofence: { enabled: true, radiusM: 1_000 },
      latestGeoAttempt: {
        id: 'attempt-1',
        result: 'LOW_ACCURACY',
        overrideRequestId: 'override-1',
      },
      override: { id: 'override-1', status: 'EXPIRED' },
      route: { id: 'route-1', started: true },
    })
  })
})
