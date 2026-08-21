import { describe, expect, it, vi } from 'vitest'
import {
  RouteStopAccessError,
  RouteStopCancelledError,
  RouteStopDateError,
  RouteStopNotStartedError,
  RouteStopVersionError,
  completeRouteStopInTransaction,
} from './route-completion'

const today = new Date('2026-08-12T00:00:00.000Z')
const now = new Date('2026-08-12T08:00:00.000Z')
const actor = { id: 'courier-1', name: 'Анна', role: 'COURIER' as const }

function stop(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    deliveryDate: today,
    version: 3,
    assignmentMode: 'IN_HOUSE',
    deliveredAt: null,
    completionMethod: null,
    cancelledAt: null,
    geofenceEnabledSnapshot: false,
    latitudeSnapshot: 55.751244,
    longitudeSnapshot: 37.618423,
    geofenceRadiusMSnapshot: 1_000,
    routeDay: {
      id: 'route-1',
      courierId: actor.id,
      startedAt: new Date('2026-08-12T07:30:00.000Z'),
      completedAt: null,
    },
    orders: [
      { id: 'order-breakfast', status: 'OUT_FOR_DELIVERY', delivery: null },
      {
        id: 'order-lunch',
        status: 'IN_PRODUCTION',
        delivery: { id: 'delivery-lunch' },
      },
    ],
    geoAttempts: [],
    ...overrides,
  }
}

function transaction(stopRow = stop()) {
  return {
    courierRouteStop: {
      findUnique: vi.fn().mockResolvedValue(stopRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    deliveryGeoAttempt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: 'attempt-1',
        ...data,
      })),
    },
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    delivery: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    courierRouteDay: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    activityLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    stopId: 'stop-1',
    expectedVersion: 3,
    requestId: 'gps-request-1',
    position: null,
    now,
    ...overrides,
  }
}

describe('completeRouteStopInTransaction', () => {
  it('completes a geofence-disabled own stop with atomic dual writes', async () => {
    const tx = transaction()

    const result = await completeRouteStopInTransaction(tx, actor, input())

    expect(tx.deliveryGeoAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stopId: 'stop-1',
        courierId: actor.id,
        requestId: 'gps-request-1',
        courierLatitude: null,
        courierLongitude: null,
        result: 'GEOFENCE_NOT_REQUIRED',
      }),
      select: expect.any(Object),
    })
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'stop-1',
        version: 3,
        deliveredAt: null,
        cancelledAt: null,
      },
      data: {
        deliveredAt: now,
        completionMethod: 'COURIER_DIRECT',
        version: { increment: 1 },
      },
    })
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['order-breakfast', 'order-lunch'] },
        status: {
          in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'],
        },
      },
      data: { status: 'DELIVERED' },
    })
    expect(tx.delivery.upsert).toHaveBeenCalledTimes(2)
    expect(tx.delivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: 'order-breakfast' },
      create: expect.objectContaining({
        orderId: 'order-breakfast',
        type: 'IN_HOUSE',
        status: 'DELIVERED',
        deliveredAt: now,
      }),
      update: expect.objectContaining({ status: 'DELIVERED', deliveredAt: now }),
    }))
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: actor.id,
        action: 'COURIER_ROUTE_STOP_DELIVERED',
        entityId: 'stop-1',
        payload: expect.not.objectContaining({
          courierLatitude: expect.anything(),
          courierLongitude: expect.anything(),
        }),
      }),
    })
    expect(tx.courierRouteDay.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'route-1',
        startedAt: { not: null },
        completedAt: null,
        stops: { none: { deliveredAt: null, cancelledAt: null } },
      },
      data: { completedAt: now },
    })
    expect(result).toEqual({
      stopId: 'stop-1',
      delivered: true,
      idempotent: false,
      version: 4,
      completionMethod: 'COURIER_DIRECT',
      geoAttempt: {
        id: 'attempt-1',
        result: 'GEOFENCE_NOT_REQUIRED',
        distanceM: null,
      },
    })
  })

  it('allows an inclusive 1000 m server-calculated geofence result', async () => {
    const tx = transaction(stop({ geofenceEnabledSnapshot: true }))
    const earthRadiusM = 6_371_000
    const longitudeDelta = (1_000 / earthRadiusM) * (180 / Math.PI)

    const result = await completeRouteStopInTransaction(tx, actor, input({
      position: {
        latitude: 55.751244,
        longitude: 37.618423 + longitudeDelta,
        accuracyM: 100,
        capturedAt: new Date(now.getTime() - 60_000),
      },
    }))

    expect(result.delivered).toBe(true)
    expect(result.completionMethod).toBe('GEOFENCE')
    expect(result.geoAttempt.result).toBe('ALLOWED')
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completionMethod: 'GEOFENCE' }),
    }))
  })

  it('persists an outside attempt but does not complete the stop', async () => {
    const tx = transaction(stop({ geofenceEnabledSnapshot: true }))

    const result = await completeRouteStopInTransaction(tx, actor, input({
      position: {
        latitude: 55.751244,
        longitude: 37.7,
        accuracyM: 20,
        capturedAt: new Date(now.getTime() - 1_000),
      },
    }))

    expect(result).toEqual(expect.objectContaining({
      delivered: false,
      idempotent: false,
      version: 3,
      geoAttempt: expect.objectContaining({ result: 'OUTSIDE_GEOFENCE' }),
    }))
    expect(tx.deliveryGeoAttempt.create).toHaveBeenCalledOnce()
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.delivery.upsert).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('rejects a foreign stop before creating a geo attempt', async () => {
    const tx = transaction(stop({
      routeDay: {
        id: 'route-foreign',
        courierId: 'courier-foreign',
        startedAt: new Date('2026-08-12T07:30:00.000Z'),
        completedAt: null,
      },
    }))

    await expect(completeRouteStopInTransaction(tx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopAccessError)
    expect(tx.deliveryGeoAttempt.create).not.toHaveBeenCalled()
  })

  it('rejects a route that has not started', async () => {
    const tx = transaction(stop({
      routeDay: {
        id: 'route-1',
        courierId: actor.id,
        startedAt: null,
        completedAt: null,
      },
    }))

    await expect(completeRouteStopInTransaction(tx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopNotStartedError)
  })

  it('rejects a stop outside authenticated courier today in MSK', async () => {
    const tx = transaction(stop({
      deliveryDate: new Date('2026-08-11T00:00:00.000Z'),
    }))

    await expect(completeRouteStopInTransaction(tx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopDateError)
  })

  it('rejects a cancelled stop and a stale expected version', async () => {
    const cancelledTx = transaction(stop({ cancelledAt: now }))
    await expect(completeRouteStopInTransaction(cancelledTx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopCancelledError)

    const changedTx = transaction(stop({ version: 4 }))
    await expect(completeRouteStopInTransaction(changedTx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopVersionError)
  })

  it('is idempotent after a committed delivery without duplicate writes', async () => {
    const deliveredAt = new Date('2026-08-12T07:55:00.000Z')
    const tx = transaction(stop({
      version: 4,
      deliveredAt,
      completionMethod: 'GEOFENCE',
      geoAttempts: [{
        id: 'attempt-existing',
        result: 'ALLOWED',
        distanceM: 123.45,
      }],
    }))

    const result = await completeRouteStopInTransaction(tx, actor, input())

    expect(result).toEqual({
      stopId: 'stop-1',
      delivered: true,
      idempotent: true,
      version: 4,
      completionMethod: 'GEOFENCE',
      geoAttempt: {
        id: 'attempt-existing',
        result: 'ALLOWED',
        distanceM: 123.45,
      },
    })
    expect(tx.deliveryGeoAttempt.create).not.toHaveBeenCalled()
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('surfaces a transaction write failure before audit and route completion', async () => {
    const tx = transaction()
    tx.delivery.upsert
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('legacy delivery write failed'))

    await expect(completeRouteStopInTransaction(tx, actor, input()))
      .rejects.toThrow('legacy delivery write failed')

    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.courierRouteDay.updateMany).not.toHaveBeenCalled()
  })

  it('rolls back when not every active order wins the conditional update', async () => {
    const tx = transaction()
    tx.order.updateMany.mockResolvedValue({ count: 1 })

    await expect(completeRouteStopInTransaction(tx, actor, input()))
      .rejects.toBeInstanceOf(RouteStopVersionError)

    expect(tx.delivery.upsert).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.courierRouteDay.updateMany).not.toHaveBeenCalled()
  })
})
