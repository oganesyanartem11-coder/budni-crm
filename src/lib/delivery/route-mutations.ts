import type { CourierAssignmentMode, UserRole } from '@prisma/client'

export interface CourierRouteActor {
  id: string
  name: string
  role: UserRole
}

export class CourierRouteAccessError extends Error {
  override name = 'CourierRouteAccessError'
}
export class CourierRouteDeliveredStopError extends Error {
  override name = 'CourierRouteDeliveredStopError'
}
export class CourierRouteCancelledStopError extends Error {
  override name = 'CourierRouteCancelledStopError'
}
export class CourierRouteVersionError extends Error {
  override name = 'CourierRouteVersionError'
}
export class CourierRouteNotFoundError extends Error {
  override name = 'CourierRouteNotFoundError'
}

const ACTIONABLE_ROUTE_ORDER_STATUSES = new Set([
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
])

interface RouteMutationTransaction {
  courierRouteDay: {
    findUnique(args: unknown): Promise<RouteDayRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
    upsert(args: unknown): Promise<RouteDayRow>
    update(args: unknown): Promise<unknown>
  }
  courierRouteStop: {
    findUnique(args: unknown): Promise<RouteStopRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  user: {
    findUnique(args: unknown): Promise<{
      id: string
      name: string
      role: UserRole
      isActive: boolean
    } | null>
  }
  activityLog: {
    create(args: unknown): Promise<unknown>
  }
}

interface RouteDayRow {
  id: string
  courierId: string
  deliveryDate?: Date
  startedAt: Date | null
  completedAt?: Date | null
}

interface RouteStopRow {
  id: string
  deliveryDate: Date
  version: number
  assignmentMode: CourierAssignmentMode
  assignmentSource: string
  assignedAt: Date
  deliveredAt: Date | null
  cancelledAt: Date | null
  routeDay: (RouteDayRow & { completedAt: Date | null }) | null
  orders: Array<{ id?: string; status: string }>
}

export async function startOwnCourierRouteInTransaction(
  txValue: unknown,
  input: {
    actor: CourierRouteActor
    deliveryDate: Date
    now: Date
  },
): Promise<{ routeDayId: string; startedAt: Date; updated: boolean }> {
  if (input.actor.role !== 'COURIER') {
    throw new CourierRouteAccessError('Только курьер может начать свой маршрут.')
  }
  const tx = txValue as RouteMutationTransaction
  const routeDay = await tx.courierRouteDay.findUnique({
    where: {
      courierId_deliveryDate: {
        courierId: input.actor.id,
        deliveryDate: input.deliveryDate,
      },
    },
    select: { id: true, courierId: true, deliveryDate: true, startedAt: true },
  })
  if (!routeDay) {
    throw new CourierRouteNotFoundError('Маршрут курьера на этот день не найден.')
  }
  if (routeDay.startedAt) {
    return {
      routeDayId: routeDay.id,
      startedAt: routeDay.startedAt,
      updated: false,
    }
  }

  const claimed = await tx.courierRouteDay.updateMany({
    where: {
      id: routeDay.id,
      courierId: input.actor.id,
      startedAt: null,
    },
    data: { startedAt: input.now },
  })
  if (claimed.count === 0) {
    const replay = await tx.courierRouteDay.findUnique({
      where: {
        courierId_deliveryDate: {
          courierId: input.actor.id,
          deliveryDate: input.deliveryDate,
        },
      },
      select: { id: true, courierId: true, deliveryDate: true, startedAt: true },
    })
    if (replay?.startedAt) {
      return {
        routeDayId: replay.id,
        startedAt: replay.startedAt,
        updated: false,
      }
    }
    throw new CourierRouteVersionError('Маршрут изменился. Обновите страницу.')
  }

  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: 'COURIER_ROUTE_STARTED',
      entityType: 'CourierRouteDay',
      entityId: routeDay.id,
      payload: {
        deliveryDate: input.deliveryDate.toISOString().slice(0, 10),
        startedAt: input.now.toISOString(),
      },
    },
  })
  return { routeDayId: routeDay.id, startedAt: input.now, updated: true }
}

export async function assignCourierRouteStopInTransaction(
  txValue: unknown,
  input: {
    actor: CourierRouteActor
    stopId: string
    expectedVersion: number
    assignmentMode: CourierAssignmentMode
    courierId: string | null
    now: Date
  },
): Promise<{ stopId: string; version: number; updated: boolean }> {
  if (!['ADMIN_PRO', 'ADMIN', 'MANAGER'].includes(input.actor.role)) {
    throw new CourierRouteAccessError('Недостаточно прав для назначения курьера.')
  }
  if (input.assignmentMode === 'IN_HOUSE' && !input.courierId) {
    throw new CourierRouteAccessError('Выберите курьера.')
  }
  if (input.assignmentMode !== 'IN_HOUSE' && input.courierId) {
    throw new CourierRouteAccessError('Для этого режима курьер не указывается.')
  }

  const tx = txValue as RouteMutationTransaction
  const stop = await tx.courierRouteStop.findUnique({
    where: { id: input.stopId },
    select: {
      id: true,
      deliveryDate: true,
      version: true,
      assignmentMode: true,
      assignmentSource: true,
      assignedAt: true,
      deliveredAt: true,
      cancelledAt: true,
      routeDay: {
        select: {
          id: true,
          courierId: true,
          startedAt: true,
          completedAt: true,
        },
      },
      orders: {
        select: { id: true, status: true },
      },
    },
  })
  if (!stop) throw new CourierRouteNotFoundError('Остановка не найдена.')
  const hasDeliveredOrder = stop.orders.some((order) => order.status === 'DELIVERED')
  const hasActionableOrder = stop.orders.some((order) =>
    ACTIONABLE_ROUTE_ORDER_STATUSES.has(order.status),
  )
  if (stop.deliveredAt || (hasDeliveredOrder && !hasActionableOrder)) {
    throw new CourierRouteDeliveredStopError('Доставленную остановку нельзя переназначить.')
  }
  if (stop.cancelledAt) {
    throw new CourierRouteCancelledStopError('Отменённую остановку нельзя переназначить.')
  }
  if (stop.version !== input.expectedVersion) {
    throw new CourierRouteVersionError('Остановка изменилась. Обновите страницу.')
  }

  const sameAssignment =
    stop.assignmentMode === input.assignmentMode &&
    (input.assignmentMode !== 'IN_HOUSE' ||
      stop.routeDay?.courierId === input.courierId)
  if (sameAssignment) {
    return { stopId: stop.id, version: stop.version, updated: false }
  }

  let targetRouteDay: RouteDayRow | null = null
  if (input.assignmentMode === 'IN_HOUSE') {
    const targetCourier = await tx.user.findUnique({
      where: { id: input.courierId! },
      select: { id: true, name: true, role: true, isActive: true },
    })
    if (!targetCourier || targetCourier.role !== 'COURIER' || !targetCourier.isActive) {
      throw new CourierRouteAccessError('Можно назначить только активного курьера.')
    }
    targetRouteDay = await tx.courierRouteDay.upsert({
      where: {
        courierId_deliveryDate: {
          courierId: targetCourier.id,
          deliveryDate: stop.deliveryDate,
        },
      },
      update: {},
      create: {
        courierId: targetCourier.id,
        courierNameSnapshot: targetCourier.name,
        deliveryDate: stop.deliveryDate,
      },
      select: {
        id: true,
        courierId: true,
        startedAt: true,
        completedAt: true,
      },
    })
  }

  const updated = await tx.courierRouteStop.updateMany({
    where: {
      id: stop.id,
      version: input.expectedVersion,
      deliveredAt: null,
      cancelledAt: null,
    },
    data: {
      routeDayId: targetRouteDay?.id ?? null,
      assignmentMode: input.assignmentMode,
      assignmentSource: 'MANAGER',
      assignedAt: input.now,
      version: { increment: 1 },
    },
  })
  if (updated.count === 0) {
    throw new CourierRouteVersionError('Остановка изменилась. Обновите страницу.')
  }

  const oldRouteStarted = Boolean(stop.routeDay?.startedAt || stop.routeDay?.completedAt)
  const newRouteStarted = Boolean(targetRouteDay?.startedAt || targetRouteDay?.completedAt)
  if (stop.routeDay && stop.routeDay.id !== targetRouteDay?.id && oldRouteStarted) {
    await tx.courierRouteDay.update({
      where: { id: stop.routeDay.id },
      data: { routeChangedAt: input.now },
    })
  }
  if (targetRouteDay && targetRouteDay.id !== stop.routeDay?.id && newRouteStarted) {
    await tx.courierRouteDay.update({
      where: { id: targetRouteDay.id },
      data: targetRouteDay.completedAt
        ? { completedAt: null, routeChangedAt: input.now }
        : { routeChangedAt: input.now },
    })
  }

  const nextVersion = stop.version + 1
  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: oldRouteStarted || newRouteStarted
        ? 'COURIER_ROUTE_STOP_REASSIGNED_AFTER_START'
        : 'COURIER_ROUTE_STOP_REASSIGNED',
      entityType: 'CourierRouteStop',
      entityId: stop.id,
      payload: {
        previous: {
          assignmentMode: stop.assignmentMode,
          routeDayId: stop.routeDay?.id ?? null,
          courierId: stop.routeDay?.courierId ?? null,
          version: stop.version,
        },
        next: {
          assignmentMode: input.assignmentMode,
          routeDayId: targetRouteDay?.id ?? null,
          courierId: targetRouteDay?.courierId ?? null,
          version: nextVersion,
        },
        assignedAt: input.now.toISOString(),
      },
    },
  })

  return { stopId: stop.id, version: nextVersion, updated: true }
}
