import { describe, expect, it, vi } from 'vitest'
import {
  DeliveryOverrideAccessError,
  DeliveryOverrideCommentError,
  completeRouteStopAsManagerInTransaction,
  createDeliveryOverrideRequestInTransaction,
  resolveDeliveryOverrideRequestInTransaction,
} from './delivery-override'

const deliveryDate = new Date('2026-08-12T00:00:00.000Z')
const now = new Date('2026-08-12T08:00:00.000Z')
const courier = { id: 'courier-1', name: 'Анна', role: 'COURIER' as const }
const manager = { id: 'manager-1', name: 'Мария', role: 'MANAGER' as const }

function stop(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    deliveryDate,
    version: 3,
    assignmentMode: 'IN_HOUSE',
    deliveredAt: null,
    completionMethod: null,
    cancelledAt: null,
    geofenceEnabledSnapshot: true,
    routeDay: {
      id: 'route-1',
      courierId: courier.id,
      courierNameSnapshot: courier.name,
      startedAt: new Date('2026-08-12T07:30:00.000Z'),
      completedAt: null,
    },
    orders: [
      { id: 'order-1', status: 'OUT_FOR_DELIVERY' },
      { id: 'order-2', status: 'IN_PRODUCTION' },
    ],
    ...overrides,
  }
}

function geoAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt-1',
    stopId: 'stop-1',
    courierId: courier.id,
    result: 'OUTSIDE_GEOFENCE',
    distanceM: 1_240,
    stop: stop(),
    overrideRequest: null,
    ...overrides,
  }
}

function pendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'override-1',
    stopId: 'stop-1',
    geoAttemptId: 'attempt-1',
    courierId: courier.id,
    courierNameSnapshot: courier.name,
    comment: 'Клиент встретил у соседнего входа',
    status: 'PENDING',
    expiresAt: new Date(now.getTime() + 15 * 60_000),
    resolvedAt: null,
    resolvedById: null,
    resolutionComment: null,
    geoAttempt: geoAttempt(),
    stop: stop(),
    ...overrides,
  }
}

function transaction() {
  return {
    deliveryGeoAttempt: {
      findUnique: vi.fn().mockResolvedValue(geoAttempt()),
    },
    deliveryOverrideRequest: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(pendingRequest()),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: 'override-1',
        ...data,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    courierRouteStop: {
      findUnique: vi.fn().mockResolvedValue(stop()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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

describe('createDeliveryOverrideRequestInTransaction', () => {
  it('persists a 15-minute pending request bound to the failed own geo attempt', async () => {
    const tx = transaction()

    const result = await createDeliveryOverrideRequestInTransaction(tx, courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: '  Клиент встретил у соседнего входа  ',
      now,
    })

    expect(tx.deliveryOverrideRequest.create).toHaveBeenCalledWith({
      data: {
        stopId: 'stop-1',
        geoAttemptId: 'attempt-1',
        courierId: courier.id,
        courierNameSnapshot: courier.name,
        comment: 'Клиент встретил у соседнего входа',
        status: 'PENDING',
        expiresAt: new Date(now.getTime() + 15 * 60_000),
      },
      select: expect.any(Object),
    })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: courier.id,
        action: 'DELIVERY_OVERRIDE_REQUESTED',
        entityId: 'override-1',
        payload: expect.not.objectContaining({
          courierLatitude: expect.anything(),
          courierLongitude: expect.anything(),
        }),
      }),
    })
    expect(result).toEqual({
      requestId: 'override-1',
      stopId: 'stop-1',
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      created: true,
    })
  })

  it('requires a comment and rejects a foreign or allowed attempt', async () => {
    const tx = transaction()
    await expect(createDeliveryOverrideRequestInTransaction(tx, courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: '   ',
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideCommentError)

    tx.deliveryGeoAttempt.findUnique.mockResolvedValueOnce(geoAttempt({
      courierId: 'courier-foreign',
    }))
    await expect(createDeliveryOverrideRequestInTransaction(tx, courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: 'Нужна помощь',
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideAccessError)

    tx.deliveryGeoAttempt.findUnique.mockResolvedValueOnce(geoAttempt({ result: 'ALLOWED' }))
    await expect(createDeliveryOverrideRequestInTransaction(tx, courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: 'Нужна помощь',
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideAccessError)
  })

  it('returns an existing live pending request without creating a duplicate', async () => {
    const tx = transaction()
    tx.deliveryOverrideRequest.findFirst.mockResolvedValue(pendingRequest())

    const result = await createDeliveryOverrideRequestInTransaction(tx, courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: 'Повторный тап',
      now,
    })

    expect(result).toEqual({
      requestId: 'override-1',
      stopId: 'stop-1',
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      created: false,
    })
    expect(tx.deliveryOverrideRequest.create).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('resolveDeliveryOverrideRequestInTransaction', () => {
  it('approves once and immediately closes the stop with legacy dual-write', async () => {
    const tx = transaction()

    const result = await resolveDeliveryOverrideRequestInTransaction(tx, manager, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: null,
      now,
    })

    expect(tx.deliveryOverrideRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'override-1', status: 'PENDING' },
      data: {
        status: 'APPROVED',
        resolvedById: manager.id,
        resolvedByNameSnapshot: manager.name,
        resolvedAt: now,
        resolutionComment: null,
      },
    })
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completionMethod: 'MANAGER_OVERRIDE' }),
    }))
    expect(tx.order.updateMany).toHaveBeenCalledOnce()
    expect(tx.delivery.upsert).toHaveBeenCalledTimes(2)
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: manager.id,
        action: 'DELIVERY_OVERRIDE_APPROVED',
        entityId: 'stop-1',
        payload: expect.objectContaining({ overrideRequestId: 'override-1' }),
      }),
    })
    expect(result).toEqual({
      requestId: 'override-1',
      status: 'APPROVED',
      stopDelivered: true,
      idempotent: false,
    })
  })

  it('rejects without completing the stop and is idempotent on repeat', async () => {
    const tx = transaction()

    const first = await resolveDeliveryOverrideRequestInTransaction(tx, manager, {
      requestId: 'override-1',
      decision: 'REJECT',
      comment: 'Подъедьте к основному входу',
      now,
    })

    expect(first).toEqual({
      requestId: 'override-1',
      status: 'REJECTED',
      stopDelivered: false,
      idempotent: false,
    })
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DELIVERY_OVERRIDE_REJECTED' }),
    })

    const repeatTx = transaction()
    repeatTx.deliveryOverrideRequest.findUnique.mockResolvedValue(pendingRequest({
      status: 'REJECTED',
      resolvedAt: now,
      resolvedById: manager.id,
    }))
    const repeat = await resolveDeliveryOverrideRequestInTransaction(repeatTx, manager, {
      requestId: 'override-1',
      decision: 'REJECT',
      comment: null,
      now: new Date(now.getTime() + 1_000),
    })

    expect(repeat).toEqual({
      requestId: 'override-1',
      status: 'REJECTED',
      stopDelivered: false,
      idempotent: true,
    })
    expect(repeatTx.deliveryOverrideRequest.updateMany).not.toHaveBeenCalled()
  })

  it('expires at TTL without resolver or delivery writes', async () => {
    const tx = transaction()
    tx.deliveryOverrideRequest.findUnique.mockResolvedValue(pendingRequest({
      expiresAt: now,
    }))

    const result = await resolveDeliveryOverrideRequestInTransaction(tx, manager, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: null,
      now,
    })

    expect(tx.deliveryOverrideRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'override-1', status: 'PENDING' },
      data: { status: 'EXPIRED', resolvedAt: now },
    })
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
    expect(result).toEqual({
      requestId: 'override-1',
      status: 'EXPIRED',
      stopDelivered: false,
      idempotent: false,
    })
  })

  it('requires an explicit active manager actor before reading the request', async () => {
    const tx = transaction()

    await expect(resolveDeliveryOverrideRequestInTransaction(tx, courier, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: null,
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideAccessError)
    expect(tx.deliveryOverrideRequest.findUnique).not.toHaveBeenCalled()
  })

  it('does not approve after the stop was reassigned away from the requesting courier', async () => {
    const tx = transaction()
    tx.deliveryOverrideRequest.findUnique.mockResolvedValue(pendingRequest({
      stop: stop({ assignmentMode: 'EXTERNAL', routeDay: null }),
    }))

    await expect(resolveDeliveryOverrideRequestInTransaction(tx, manager, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: null,
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideAccessError)

    expect(tx.deliveryOverrideRequest.updateMany).not.toHaveBeenCalled()
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
  })
})

describe('completeRouteStopAsManagerInTransaction', () => {
  it('closes an EXTERNAL/InDrive stop without GPS or a reason', async () => {
    const tx = transaction()
    tx.courierRouteStop.findUnique.mockResolvedValue(stop({
      assignmentMode: 'EXTERNAL',
      routeDay: null,
    }))

    const result = await completeRouteStopAsManagerInTransaction(tx, manager, {
      stopId: 'stop-1',
      expectedVersion: 3,
      reason: null,
      now,
    })

    expect(tx.delivery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        type: 'EXTERNAL_COURIER',
        courierName: 'InDrive',
      }),
    }))
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ completionMethod: 'MANAGER_DIRECT' }),
    }))
    expect(result).toEqual({
      stopId: 'stop-1',
      delivered: true,
      idempotent: false,
      version: 4,
      completionMethod: 'MANAGER_DIRECT',
    })
  })

  it('requires a reason for direct completion of an internal stop', async () => {
    const tx = transaction()

    await expect(completeRouteStopAsManagerInTransaction(tx, manager, {
      stopId: 'stop-1',
      expectedVersion: 3,
      reason: '   ',
      now,
    })).rejects.toBeInstanceOf(DeliveryOverrideCommentError)
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
  })

  it('preserves the actual completion method on an idempotent manager replay', async () => {
    const tx = transaction()
    tx.courierRouteStop.findUnique.mockResolvedValue(stop({
      version: 4,
      deliveredAt: now,
      completionMethod: 'GEOFENCE',
    }))

    const result = await completeRouteStopAsManagerInTransaction(tx, manager, {
      stopId: 'stop-1',
      expectedVersion: 3,
      reason: null,
      now: new Date(now.getTime() + 1_000),
    })

    expect(result).toEqual(expect.objectContaining({
      idempotent: true,
      version: 4,
      completionMethod: 'GEOFENCE',
    }))
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
  })
})
