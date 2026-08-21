import { describe, expect, it, vi } from 'vitest'
import {
  CourierRouteAccessError,
  CourierRouteDeliveredStopError,
  assignCourierRouteStopInTransaction,
  startOwnCourierRouteInTransaction,
} from './route-mutations'

const deliveryDate = new Date('2026-08-12T00:00:00.000Z')
const now = new Date('2026-08-12T06:00:00.000Z')
const courier = { id: 'courier-1', name: 'Анна', role: 'COURIER' as const }
const manager = { id: 'manager-1', name: 'Мария', role: 'MANAGER' as const }

describe('startOwnCourierRouteInTransaction', () => {
  function transaction(startedAt: Date | null, claimed = 1) {
    const route = {
      id: 'route-1',
      courierId: courier.id,
      deliveryDate,
      startedAt,
    }
    return {
      courierRouteDay: {
        findUnique: vi.fn().mockResolvedValue(route),
        updateMany: vi.fn().mockResolvedValue({ count: claimed }),
      },
      activityLog: { create: vi.fn().mockResolvedValue({}) },
    }
  }

  it('starts only the authenticated courier route and logs once', async () => {
    const tx = transaction(null)

    const result = await startOwnCourierRouteInTransaction(tx, {
      actor: courier,
      deliveryDate,
      now,
    })

    expect(tx.courierRouteDay.findUnique).toHaveBeenCalledWith({
      where: {
        courierId_deliveryDate: { courierId: courier.id, deliveryDate },
      },
      select: { id: true, courierId: true, deliveryDate: true, startedAt: true },
    })
    expect(tx.courierRouteDay.updateMany).toHaveBeenCalledWith({
      where: { id: 'route-1', courierId: courier.id, startedAt: null },
      data: { startedAt: now },
    })
    expect(tx.activityLog.create).toHaveBeenCalledOnce()
    expect(result).toEqual({
      routeDayId: 'route-1',
      startedAt: now,
      updated: true,
    })
  })

  it('is idempotent after the route already started', async () => {
    const originalStartedAt = new Date('2026-08-12T05:45:00.000Z')
    const tx = transaction(originalStartedAt, 0)

    const result = await startOwnCourierRouteInTransaction(tx, {
      actor: courier,
      deliveryDate,
      now,
    })

    expect(tx.courierRouteDay.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(result).toEqual({
      routeDayId: 'route-1',
      startedAt: originalStartedAt,
      updated: false,
    })
  })

  it('rejects a non-courier actor before reading a route', async () => {
    const tx = transaction(null)

    await expect(startOwnCourierRouteInTransaction(tx, {
      actor: manager,
      deliveryDate,
      now,
    })).rejects.toBeInstanceOf(CourierRouteAccessError)
    expect(tx.courierRouteDay.findUnique).not.toHaveBeenCalled()
  })
})

describe('assignCourierRouteStopInTransaction', () => {
  function stop(over: Record<string, unknown> = {}) {
    return {
      id: 'stop-1',
      deliveryDate,
      version: 3,
      assignmentMode: 'IN_HOUSE',
      assignmentSource: 'LOCATION_DEFAULT',
      assignedAt: new Date('2026-08-11T15:00:00.000Z'),
      deliveredAt: null,
      cancelledAt: null,
      routeDay: {
        id: 'route-old',
        courierId: 'courier-old',
        startedAt: new Date('2026-08-12T05:30:00.000Z'),
        completedAt: null,
      },
      orders: [],
      ...over,
    }
  }

  function transaction(stopRow = stop()) {
    return {
      courierRouteStop: {
        findUnique: vi.fn().mockResolvedValue(stopRow),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'courier-new',
          name: 'Борис',
          role: 'COURIER',
          isActive: true,
        }),
      },
      courierRouteDay: {
        upsert: vi.fn().mockResolvedValue({
          id: 'route-new',
          courierId: 'courier-new',
          startedAt: new Date('2026-08-12T05:40:00.000Z'),
          completedAt: new Date('2026-08-12T05:55:00.000Z'),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      activityLog: { create: vi.fn().mockResolvedValue({}) },
    }
  }

  it('reassigns to an active courier, reopens the target route and audits after start', async () => {
    const tx = transaction()

    const result = await assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'IN_HOUSE',
      courierId: 'courier-new',
      now,
    })

    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'courier-new' },
      select: { id: true, name: true, role: true, isActive: true },
    })
    expect(tx.courierRouteDay.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        courierId_deliveryDate: { courierId: 'courier-new', deliveryDate },
      },
      update: {},
    }))
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledWith({
      where: { id: 'stop-1', version: 3, deliveredAt: null, cancelledAt: null },
      data: {
        routeDayId: 'route-new',
        assignmentMode: 'IN_HOUSE',
        assignmentSource: 'MANAGER',
        assignedAt: now,
        version: { increment: 1 },
      },
    })
    expect(tx.courierRouteDay.update).toHaveBeenCalledWith({
      where: { id: 'route-new' },
      data: { completedAt: null, routeChangedAt: now },
    })
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'COURIER_ROUTE_STOP_REASSIGNED_AFTER_START',
        entityType: 'CourierRouteStop',
        entityId: 'stop-1',
      }),
    }))
    expect(result).toEqual({ stopId: 'stop-1', version: 4, updated: true })
  })

  it('reassigns to external without accepting an injected courier id', async () => {
    const tx = transaction()

    await expect(assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'EXTERNAL',
      courierId: 'courier-injected',
      now,
    })).rejects.toBeInstanceOf(CourierRouteAccessError)

    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a delivered stop before courier lookup or writes', async () => {
    const tx = transaction(stop({ deliveredAt: new Date('2026-08-12T05:50:00.000Z') }))

    await expect(assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'IN_HOUSE',
      courierId: 'courier-new',
      now,
    })).rejects.toBeInstanceOf(CourierRouteDeliveredStopError)

    expect(tx.user.findUnique).not.toHaveBeenCalled()
    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
  })

  it('allows a reopened stop with an old delivered order and a new active order', async () => {
    const tx = transaction(stop({
      deliveredAt: null,
      orders: [
        { id: 'old-order', status: 'DELIVERED' },
        { id: 'new-order', status: 'CONFIRMED' },
      ],
    }))

    const result = await assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'IN_HOUSE',
      courierId: 'courier-new',
      now,
    })

    expect(tx.user.findUnique).toHaveBeenCalledOnce()
    expect(tx.courierRouteStop.updateMany).toHaveBeenCalledOnce()
    expect(result).toEqual({ stopId: 'stop-1', version: 4, updated: true })
  })

  it('still rejects an inconsistent legacy stop with only delivered orders', async () => {
    const tx = transaction(stop({
      deliveredAt: null,
      orders: [{ id: 'delivered-order', status: 'DELIVERED' }],
    }))

    await expect(assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'IN_HOUSE',
      courierId: 'courier-new',
      now,
    })).rejects.toBeInstanceOf(CourierRouteDeliveredStopError)

    expect(tx.user.findUnique).not.toHaveBeenCalled()
  })

  it('returns an idempotent no-op for the exact same daily assignment', async () => {
    const tx = transaction(stop({
      routeDay: {
        id: 'route-old',
        courierId: 'courier-new',
        startedAt: null,
        completedAt: null,
      },
    }))

    const result = await assignCourierRouteStopInTransaction(tx, {
      actor: manager,
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'IN_HOUSE',
      courierId: 'courier-new',
      now,
    })

    expect(tx.courierRouteStop.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(result).toEqual({ stopId: 'stop-1', version: 3, updated: false })
  })
})
