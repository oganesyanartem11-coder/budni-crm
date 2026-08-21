import { describe, expect, it, vi } from 'vitest'
import {
  buildRouteMaterializationPlan,
  ensureCourierRouteStopsForDateInTransaction,
  type RouteMaterializerOrder,
} from './route-materializer'

const deliveryDate = new Date('2026-08-12T00:00:00.000Z')
const now = new Date('2026-08-11T15:10:00.000Z')

function order(
  over: Partial<RouteMaterializerOrder> = {},
): RouteMaterializerOrder {
  const clientId = over.clientId ?? 'client-1'
  const locationId = over.locationId ?? 'location-1'
  return {
    id: over.id ?? 'order-1',
    clientId,
    locationId,
    deliveryDate: over.deliveryDate ?? deliveryDate,
    mealType: over.mealType ?? 'LUNCH',
    status: over.status ?? 'CONFIRMED',
    client: over.client ?? {
      name: 'Клиент до изменений',
      contactName: 'Legacy',
      contactPhone: '+70000000000',
      contacts: [
        {
          id: 'contact-location',
          clientId,
          locationId,
          isPrimaryForDelivery: true,
          name: 'Встречающий',
          phone: '+79991112233',
          notes: 'Позвонить у шлагбаума',
          sortOrder: 0,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    },
    location: over.location ?? {
      name: 'Точка до изменений',
      address: 'Старый адрес, 1',
      deliveryWindowFrom: '11:00',
      deliveryWindowTo: '12:00',
      deliveryInstructions: 'Вход со двора',
      defaultDeliveryMode: 'IN_HOUSE',
      assignedCourierId: 'courier-1',
      assignedCourier: {
        id: 'courier-1',
        name: 'Анна',
        role: 'COURIER',
        isActive: true,
      },
      latitude: 55.7558,
      longitude: 37.6173,
      geofenceRadiusM: 1000,
      geofenceEnabled: true,
    },
  }
}

describe('buildRouteMaterializationPlan', () => {
  it('aggregates three meal types into one stop and attaches every order', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [
        order({ id: 'breakfast', mealType: 'BREAKFAST' }),
        order({ id: 'lunch', mealType: 'LUNCH' }),
        order({ id: 'dinner', mealType: 'DINNER' }),
      ],
      existingStops: [],
      existingRouteDays: [],
    })

    expect(plan.newStops).toHaveLength(1)
    expect(plan.newStops[0].orderIds).toEqual(['breakfast', 'dinner', 'lunch'])
    expect(plan.newStops[0].assignment).toEqual({
      mode: 'IN_HOUSE',
      source: 'LOCATION_DEFAULT',
      courier: { id: 'courier-1', name: 'Анна' },
    })
    expect(plan.newStops[0].snapshot).toEqual(expect.objectContaining({
      clientNameSnapshot: 'Клиент до изменений',
      locationNameSnapshot: 'Точка до изменений',
      contactNameSnapshot: 'Встречающий',
      contactPhoneSnapshot: '+79991112233',
      contactNotesSnapshot: 'Позвонить у шлагбаума',
      geofenceEnabledSnapshot: true,
    }))
  })

  it('keeps an existing daily assignment and snapshots after location defaults change', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [
        order({
          location: {
            ...order().location,
            name: 'Переименованная точка',
            assignedCourierId: 'courier-2',
            assignedCourier: {
              id: 'courier-2',
              name: 'Борис',
              role: 'COURIER',
              isActive: true,
            },
          },
        }),
      ],
      existingStops: [{
        id: 'stop-existing',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: null,
        cancelledAt: null,
      }],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        completedAt: null,
      }],
    })

    expect(plan.newStops).toEqual([])
    expect(plan.existingStops).toEqual([{
      stopId: 'stop-existing',
      orderIds: ['order-1'],
      cancellation: 'UNCHANGED',
      reopenRouteDayId: null,
    }])
  })

  it('does not create a second stop when a new meal type appears', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [
        order({ id: 'lunch', mealType: 'LUNCH' }),
        order({ id: 'dinner', mealType: 'DINNER' }),
      ],
      existingStops: [{
        id: 'stop-existing',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: null,
        cancelledAt: null,
      }],
      existingRouteDays: [],
    })

    expect(plan.newStops).toHaveLength(0)
    expect(plan.existingStops[0].orderIds).toEqual(['dinner', 'lunch'])
  })

  it('cancels a stop when all orders are cancelled and reopens it for a new active order', () => {
    const existing = {
      id: 'stop-existing',
      clientId: 'client-1',
      locationId: 'location-1',
      routeDayId: 'route-anna',
      assignmentMode: 'IN_HOUSE' as const,
      assignedAt: new Date('2026-08-11T10:00:00.000Z'),
      deliveredAt: null,
      cancelledAt: null,
    }
    const cancelled = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order({ status: 'CANCELLED' })],
      existingStops: [existing],
      existingRouteDays: [],
    })
    expect(cancelled.existingStops[0].cancellation).toBe('CANCEL')

    const reopened = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order({ id: 'new-active', status: 'CONFIRMED' })],
      existingStops: [{ ...existing, cancelledAt: new Date('2026-08-11T14:00:00.000Z') }],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        completedAt: new Date('2026-08-11T14:30:00.000Z'),
      }],
    })
    expect(reopened.existingStops[0]).toEqual(expect.objectContaining({
      cancellation: 'REOPEN',
      reopenRouteDayId: 'route-anna',
    }))
  })

  it('reopens a completed route when a newly materialized stop is assigned to it', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order()],
      existingStops: [],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        completedAt: new Date('2026-08-11T14:30:00.000Z'),
      }],
    })

    expect(plan.newStops[0].reopenRouteDayId).toBe('route-anna')
  })

  it('marks routeChangedAt when a new stop appears after route start', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order()],
      existingStops: [],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        startedAt: new Date('2026-08-11T14:00:00.000Z'),
        completedAt: null,
      }],
    })

    expect(plan.newStops[0].touchRouteDayId).toBe('route-anna')
    expect(plan.newStops[0].reopenRouteDayId).toBeNull()
  })

  it('does not propose snapshot changes for an already delivered stop', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order({
        location: {
          ...order().location,
          address: 'Совсем новый адрес',
          deliveryInstructions: 'Новая инструкция',
        },
      })],
      existingStops: [{
        id: 'stop-delivered',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: new Date('2026-08-11T13:00:00.000Z'),
        cancelledAt: null,
      }],
      existingRouteDays: [],
    })

    expect(plan.newStops).toEqual([])
    expect(plan.existingStops[0]).not.toHaveProperty('snapshot')
  })

  it('never cancels a delivered stop even if linked orders are later cancelled', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order({ status: 'CANCELLED' })],
      existingStops: [{
        id: 'stop-delivered',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: new Date('2026-08-11T13:00:00.000Z'),
        cancelledAt: null,
      }],
      existingRouteDays: [],
    })

    expect(plan.existingStops[0].cancellation).toBe('UNCHANGED')
  })

  it('reopens a delivered stop when a new actionable order appears without rewriting snapshots', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [
        order({ id: 'old-delivered', status: 'DELIVERED' }),
        order({ id: 'new-lunch', status: 'CONFIRMED' }),
      ],
      existingStops: [{
        id: 'stop-delivered',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: new Date('2026-08-11T13:00:00.000Z'),
        cancelledAt: null,
      }],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        startedAt: new Date('2026-08-11T09:00:00.000Z'),
        completedAt: new Date('2026-08-11T13:05:00.000Z'),
      }],
    })

    expect(plan.existingStops[0]).toEqual(expect.objectContaining({
      stopId: 'stop-delivered',
      reopenCompletion: true,
      reopenRouteDayId: 'route-anna',
    }))
    expect(plan.existingStops[0]).not.toHaveProperty('snapshot')
  })

  it('touches routeChangedAt when a stop is cancelled after route start', () => {
    const plan = buildRouteMaterializationPlan({
      deliveryDate,
      now,
      orders: [order({ status: 'CANCELLED' })],
      existingStops: [{
        id: 'stop-existing',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: null,
        cancelledAt: null,
      }],
      existingRouteDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        startedAt: new Date('2026-08-11T09:00:00.000Z'),
        completedAt: null,
      }],
    })

    expect(plan.existingStops[0]).toEqual(expect.objectContaining({
      cancellation: 'CANCEL',
      touchRouteDayId: 'route-anna',
    }))
  })
})

describe('ensureCourierRouteStopsForDateInTransaction', () => {
  function transaction(over: {
    orders?: RouteMaterializerOrder[]
    stops?: unknown[]
    routeDays?: unknown[]
    attachedCount?: number
  } = {}) {
    return {
      order: {
        findMany: vi.fn().mockResolvedValue(over.orders ?? [order()]),
        updateMany: vi.fn().mockResolvedValue({ count: over.attachedCount ?? 1 }),
      },
      courierRouteStop: {
        findMany: vi.fn().mockResolvedValue(over.stops ?? []),
        upsert: vi.fn().mockResolvedValue({ id: 'stop-created' }),
        update: vi.fn().mockResolvedValue({}),
      },
      courierRouteDay: {
        findMany: vi.fn().mockResolvedValue(over.routeDays ?? []),
        upsert: vi.fn().mockResolvedValue({ id: 'route-anna' }),
        update: vi.fn().mockResolvedValue({}),
      },
    }
  }

  it('creates one route stop, upserts its route day and attaches all meal orders', async () => {
    const tx = transaction({
      orders: [
        order({ id: 'breakfast', mealType: 'BREAKFAST' }),
        order({ id: 'lunch', mealType: 'LUNCH' }),
        order({ id: 'dinner', mealType: 'DINNER' }),
      ],
      attachedCount: 3,
    })

    const result = await ensureCourierRouteStopsForDateInTransaction(tx, {
      deliveryDate,
      now,
    })

    expect(tx.courierRouteDay.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        courierId_deliveryDate: { courierId: 'courier-1', deliveryDate },
      },
      update: {},
      create: expect.objectContaining({
        courierId: 'courier-1',
        courierNameSnapshot: 'Анна',
        deliveryDate,
      }),
    }))
    expect(tx.courierRouteStop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        deliveryDate_clientId_locationId: {
          deliveryDate,
          clientId: 'client-1',
          locationId: 'location-1',
        },
      },
      update: {},
      create: expect.objectContaining({
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignmentSource: 'LOCATION_DEFAULT',
        clientNameSnapshot: 'Клиент до изменений',
      }),
    }))
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['breakfast', 'dinner', 'lunch'] },
        OR: [
          { routeStopId: null },
          { routeStopId: { not: 'stop-created' } },
        ],
      },
      data: { routeStopId: 'stop-created' },
    })
    expect(result).toEqual(expect.objectContaining({
      stopsCreated: 1,
      ordersAttached: 3,
    }))
  })

  it('does not rewrite an unchanged existing stop or bump its version', async () => {
    const existing = {
      id: 'stop-existing',
      clientId: 'client-1',
      locationId: 'location-1',
      routeDayId: 'route-anna',
      assignmentMode: 'IN_HOUSE',
      assignedAt: new Date('2026-08-11T10:00:00.000Z'),
      deliveredAt: null,
      cancelledAt: null,
    }
    const tx = transaction({
      stops: [existing],
      routeDays: [{ id: 'route-anna', courierId: 'courier-1', completedAt: null }],
      attachedCount: 0,
    })

    const result = await ensureCourierRouteStopsForDateInTransaction(tx, {
      deliveryDate,
      now,
    })

    expect(tx.courierRouteStop.upsert).not.toHaveBeenCalled()
    expect(tx.courierRouteStop.update).not.toHaveBeenCalled()
    expect(tx.courierRouteDay.upsert).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({
      stopsCreated: 0,
      ordersAttached: 0,
    }))
  })

  it('reopens a cancelled stop and its completed route with one version bump', async () => {
    const tx = transaction({
      stops: [{
        id: 'stop-existing',
        clientId: 'client-1',
        locationId: 'location-1',
        routeDayId: 'route-anna',
        assignmentMode: 'IN_HOUSE',
        assignedAt: new Date('2026-08-11T10:00:00.000Z'),
        deliveredAt: null,
        cancelledAt: new Date('2026-08-11T14:00:00.000Z'),
      }],
      routeDays: [{
        id: 'route-anna',
        courierId: 'courier-1',
        completedAt: new Date('2026-08-11T14:30:00.000Z'),
      }],
      attachedCount: 1,
    })

    const result = await ensureCourierRouteStopsForDateInTransaction(tx, {
      deliveryDate,
      now,
    })

    expect(tx.courierRouteStop.update).toHaveBeenCalledWith({
      where: { id: 'stop-existing' },
      data: { cancelledAt: null, version: { increment: 1 } },
    })
    expect(tx.courierRouteDay.update).toHaveBeenCalledWith({
      where: { id: 'route-anna' },
      data: { completedAt: null, routeChangedAt: now },
    })
    expect(result.stopsReopened).toBe(1)
    expect(result.routeDaysReopened).toBe(1)
  })
})
