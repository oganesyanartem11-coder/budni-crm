import {
  resolveDeliveryContact,
  type DeliveryContactCandidate,
} from './contact-resolver'
import { runWithPrismaConflictRetry } from './prisma-transaction-retry'
import { normalizeMskDeliveryDate } from './route-domain'

export type RouteOrderStatus =
  | 'CONFIRMED'
  | 'LOCKED'
  | 'IN_PRODUCTION'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'

export type RouteAssignmentMode = 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'

export interface RouteMaterializerOrder {
  id: string
  clientId: string
  locationId: string
  deliveryDate: Date
  mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER'
  status: RouteOrderStatus
  client: {
    name: string
    contactName: string | null
    contactPhone: string | null
    contacts: DeliveryContactCandidate[]
  }
  location: {
    name: string
    address: string
    deliveryWindowFrom: string | null
    deliveryWindowTo: string | null
    deliveryInstructions: string | null
    defaultDeliveryMode: RouteAssignmentMode | null
    assignedCourierId: string | null
    assignedCourier: {
      id: string
      name: string
      role: string
      isActive: boolean
    } | null
    latitude: number | null
    longitude: number | null
    geofenceRadiusM: number
    geofenceEnabled: boolean
  }
}

export interface ExistingRouteStop {
  id: string
  clientId: string
  locationId: string
  routeDayId: string | null
  assignmentMode: RouteAssignmentMode
  assignedAt: Date
  deliveredAt: Date | null
  cancelledAt: Date | null
}

export interface ExistingRouteDay {
  id: string
  courierId: string
  startedAt?: Date | null
  completedAt: Date | null
}

export interface RouteStopSnapshot {
  clientNameSnapshot: string
  locationNameSnapshot: string
  locationAddressSnapshot: string
  contactNameSnapshot: string | null
  contactPhoneSnapshot: string | null
  contactNotesSnapshot: string | null
  deliveryWindowFromSnapshot: string | null
  deliveryWindowToSnapshot: string | null
  deliveryInstructionsSnapshot: string | null
  latitudeSnapshot: number | null
  longitudeSnapshot: number | null
  geofenceRadiusMSnapshot: number
  geofenceEnabledSnapshot: boolean
}

export interface RouteMaterializationPlan {
  newStops: Array<{
    clientId: string
    locationId: string
    orderIds: string[]
    assignment: {
      mode: RouteAssignmentMode
      source: 'LOCATION_DEFAULT'
      courier: { id: string; name: string } | null
    }
    snapshot: RouteStopSnapshot
    cancelledAt: Date | null
    reopenRouteDayId: string | null
    touchRouteDayId?: string
  }>
  existingStops: Array<{
    stopId: string
    orderIds: string[]
    cancellation: 'UNCHANGED' | 'CANCEL' | 'REOPEN'
    reopenRouteDayId: string | null
    touchRouteDayId?: string
    reopenCompletion?: true
  }>
}

export function buildRouteMaterializationPlan(_input: {
  deliveryDate: Date
  now: Date
  orders: RouteMaterializerOrder[]
  existingStops: ExistingRouteStop[]
  existingRouteDays: ExistingRouteDay[]
}): RouteMaterializationPlan {
  const input = _input
  const existingStops = new Map(
    input.existingStops.map((stop) => [stopKey(stop.clientId, stop.locationId), stop]),
  )
  const routeDaysById = new Map(
    input.existingRouteDays.map((routeDay) => [routeDay.id, routeDay]),
  )
  const routeDaysByCourier = new Map(
    input.existingRouteDays.map((routeDay) => [routeDay.courierId, routeDay]),
  )
  const orderGroups = new Map<string, RouteMaterializerOrder[]>()

  for (const order of input.orders) {
    const key = stopKey(order.clientId, order.locationId)
    const group = orderGroups.get(key)
    if (group) group.push(order)
    else orderGroups.set(key, [order])
  }

  const plan: RouteMaterializationPlan = { newStops: [], existingStops: [] }
  for (const [key, unsortedOrders] of [...orderGroups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const orders = [...unsortedOrders].sort((a, b) => a.id.localeCompare(b.id))
    const orderIds = orders.map((order) => order.id)
    const hasActionableOrder = orders.some((order) =>
      ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'].includes(
        order.status,
      ),
    )
    const allOrdersCancelled = orders.every((order) => order.status === 'CANCELLED')
    const existing = existingStops.get(key)

    if (existing) {
      let cancellation: 'UNCHANGED' | 'CANCEL' | 'REOPEN' = 'UNCHANGED'
      if (!existing.deliveredAt) {
        if (allOrdersCancelled && !existing.cancelledAt) cancellation = 'CANCEL'
        if (hasActionableOrder && existing.cancelledAt) cancellation = 'REOPEN'
      }
      const reopenCompletion = Boolean(existing.deliveredAt && hasActionableOrder)

      const routeDay = existing.routeDayId
        ? routeDaysById.get(existing.routeDayId)
        : null
      plan.existingStops.push({
        stopId: existing.id,
        orderIds,
        cancellation,
        reopenRouteDayId:
          (cancellation === 'REOPEN' || reopenCompletion) && routeDay?.completedAt
            ? routeDay.id
            : null,
        ...((cancellation === 'REOPEN' || reopenCompletion) &&
        routeDay?.startedAt &&
        !routeDay.completedAt
          ? { touchRouteDayId: routeDay.id }
          : {}),
        ...(cancellation === 'CANCEL' && (routeDay?.startedAt || routeDay?.completedAt)
          ? { touchRouteDayId: routeDay.id }
          : {}),
        ...(reopenCompletion ? { reopenCompletion: true as const } : {}),
      })
      continue
    }

    const first = orders[0]
    const assignment = resolveDefaultAssignment(first)
    const contact = resolveDeliveryContact({
      clientId: first.clientId,
      locationId: first.locationId,
      contacts: first.client.contacts,
      legacy: {
        name: first.client.contactName,
        phone: first.client.contactPhone,
      },
    })
    const existingRouteDay = assignment.courier
      ? routeDaysByCourier.get(assignment.courier.id)
      : null

    plan.newStops.push({
      clientId: first.clientId,
      locationId: first.locationId,
      orderIds,
      assignment,
      snapshot: {
        clientNameSnapshot: first.client.name,
        locationNameSnapshot: first.location.name,
        locationAddressSnapshot: first.location.address,
        contactNameSnapshot: contact?.name ?? null,
        contactPhoneSnapshot: contact?.phone ?? null,
        contactNotesSnapshot: contact?.notes ?? null,
        deliveryWindowFromSnapshot: first.location.deliveryWindowFrom,
        deliveryWindowToSnapshot: first.location.deliveryWindowTo,
        deliveryInstructionsSnapshot: first.location.deliveryInstructions,
        latitudeSnapshot: first.location.latitude,
        longitudeSnapshot: first.location.longitude,
        geofenceRadiusMSnapshot: first.location.geofenceRadiusM,
        geofenceEnabledSnapshot: first.location.geofenceEnabled,
      },
      cancelledAt: allOrdersCancelled ? input.now : null,
      reopenRouteDayId:
        !allOrdersCancelled && existingRouteDay?.completedAt
          ? existingRouteDay.id
          : null,
      ...(!allOrdersCancelled && existingRouteDay?.startedAt && !existingRouteDay.completedAt
        ? { touchRouteDayId: existingRouteDay.id }
        : {}),
    })
  }

  return plan
}

function stopKey(clientId: string, locationId: string): string {
  return `${clientId}\u0000${locationId}`
}

function resolveDefaultAssignment(order: RouteMaterializerOrder): {
  mode: RouteAssignmentMode
  source: 'LOCATION_DEFAULT'
  courier: { id: string; name: string } | null
} {
  const requestedMode = order.location.defaultDeliveryMode ?? (
    order.location.assignedCourierId ? 'IN_HOUSE' : 'EXTERNAL'
  )

  if (requestedMode !== 'IN_HOUSE') {
    return {
      mode: requestedMode,
      source: 'LOCATION_DEFAULT',
      courier: null,
    }
  }

  const courier = order.location.assignedCourier
  if (
    !courier ||
    courier.id !== order.location.assignedCourierId ||
    courier.role !== 'COURIER' ||
    !courier.isActive
  ) {
    return {
      mode: 'UNASSIGNED',
      source: 'LOCATION_DEFAULT',
      courier: null,
    }
  }

  return {
    mode: 'IN_HOUSE',
    source: 'LOCATION_DEFAULT',
    courier: { id: courier.id, name: courier.name },
  }
}

const ROUTE_ORDER_STATUSES: RouteOrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
]

const ROUTE_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 10_000,
  isolationLevel: 'Serializable' as const,
}

interface RouteMaterializerTransaction {
  order: {
    findMany(args: unknown): Promise<unknown[]>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  courierRouteStop: {
    findMany(args: unknown): Promise<unknown[]>
    upsert(args: unknown): Promise<{ id: string }>
    update(args: unknown): Promise<unknown>
  }
  courierRouteDay: {
    findMany(args: unknown): Promise<unknown[]>
    upsert(args: unknown): Promise<{ id: string }>
    update(args: unknown): Promise<unknown>
  }
}

interface DecimalLike {
  toNumber(): number
}

interface RouteMaterializerDatabaseOrder extends Omit<RouteMaterializerOrder, 'location'> {
  location: Omit<RouteMaterializerOrder['location'], 'latitude' | 'longitude'> & {
    latitude: DecimalLike | number | null
    longitude: DecimalLike | number | null
  }
}

export interface RouteMaterializationResult {
  stopsCreated: number
  ordersAttached: number
  stopsCancelled: number
  stopsReopened: number
  deliveredStopsReopened: number
  routeDaysReopened: number
  routeDaysChanged: number
}

function decimalToNumber(value: DecimalLike | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : value.toNumber()
}

/**
 * Database core for one exact @db.Date. It performs no network calls and keeps
 * the caller-controlled interactive transaction limited to database work.
 */
export async function ensureCourierRouteStopsForDateInTransaction(
  tx: RouteMaterializerTransaction,
  input: { deliveryDate: Date; now: Date },
): Promise<RouteMaterializationResult> {
  const databaseOrders = await tx.order.findMany({
    where: {
      deliveryDate: input.deliveryDate,
      status: { in: ROUTE_ORDER_STATUSES },
    },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      deliveryDate: true,
      mealType: true,
      status: true,
      client: {
        select: {
          name: true,
          contactName: true,
          contactPhone: true,
          contacts: {
            select: {
              id: true,
              clientId: true,
              locationId: true,
              isPrimaryForDelivery: true,
              name: true,
              phone: true,
              notes: true,
              sortOrder: true,
              createdAt: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          },
        },
      },
      location: {
        select: {
          name: true,
          address: true,
          deliveryWindowFrom: true,
          deliveryWindowTo: true,
          deliveryInstructions: true,
          defaultDeliveryMode: true,
          assignedCourierId: true,
          assignedCourier: {
            select: { id: true, name: true, role: true, isActive: true },
          },
          latitude: true,
          longitude: true,
          geofenceRadiusM: true,
          geofenceEnabled: true,
        },
      },
    },
  }) as RouteMaterializerDatabaseOrder[]

  const orders: RouteMaterializerOrder[] = databaseOrders.map((order) => ({
    ...order,
    location: {
      ...order.location,
      latitude: decimalToNumber(order.location.latitude),
      longitude: decimalToNumber(order.location.longitude),
    },
  }))
  const existingStops = await tx.courierRouteStop.findMany({
    where: { deliveryDate: input.deliveryDate },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      routeDayId: true,
      assignmentMode: true,
      assignedAt: true,
      deliveredAt: true,
      cancelledAt: true,
    },
  }) as ExistingRouteStop[]
  const existingRouteDays = await tx.courierRouteDay.findMany({
    where: { deliveryDate: input.deliveryDate },
    select: { id: true, courierId: true, startedAt: true, completedAt: true },
  }) as ExistingRouteDay[]

  const plan = buildRouteMaterializationPlan({
    deliveryDate: input.deliveryDate,
    now: input.now,
    orders,
    existingStops,
    existingRouteDays,
  })
  const result: RouteMaterializationResult = {
    stopsCreated: 0,
    ordersAttached: 0,
    stopsCancelled: 0,
    stopsReopened: 0,
    deliveredStopsReopened: 0,
    routeDaysReopened: 0,
    routeDaysChanged: 0,
  }

  for (const operation of plan.newStops) {
    const routeDay = operation.assignment.courier
      ? await tx.courierRouteDay.upsert({
          where: {
            courierId_deliveryDate: {
              courierId: operation.assignment.courier.id,
              deliveryDate: input.deliveryDate,
            },
          },
          update: {},
          create: {
            courierId: operation.assignment.courier.id,
            courierNameSnapshot: operation.assignment.courier.name,
            deliveryDate: input.deliveryDate,
          },
          select: { id: true },
        })
      : null

    const stop = await tx.courierRouteStop.upsert({
      where: {
        deliveryDate_clientId_locationId: {
          deliveryDate: input.deliveryDate,
          clientId: operation.clientId,
          locationId: operation.locationId,
        },
      },
      update: {},
      create: {
        deliveryDate: input.deliveryDate,
        clientId: operation.clientId,
        locationId: operation.locationId,
        routeDayId: routeDay?.id ?? null,
        assignmentMode: operation.assignment.mode,
        assignmentSource: operation.assignment.source,
        ...operation.snapshot,
        assignedAt: input.now,
        cancelledAt: operation.cancelledAt,
      },
      select: { id: true },
    })
    result.stopsCreated += 1

    const attached = await tx.order.updateMany({
      where: {
        id: { in: operation.orderIds },
        OR: [
          { routeStopId: null },
          { routeStopId: { not: stop.id } },
        ],
      },
      data: { routeStopId: stop.id },
    })
    result.ordersAttached += attached.count

    if (operation.reopenRouteDayId) {
      await reopenRouteDay(tx, operation.reopenRouteDayId, input.now)
      result.routeDaysReopened += 1
      result.routeDaysChanged += 1
    } else if (operation.touchRouteDayId) {
      await touchRouteDay(tx, operation.touchRouteDayId, input.now)
      result.routeDaysChanged += 1
    }
  }

  for (const operation of plan.existingStops) {
    const attached = await tx.order.updateMany({
      where: {
        id: { in: operation.orderIds },
        OR: [
          { routeStopId: null },
          { routeStopId: { not: operation.stopId } },
        ],
      },
      data: { routeStopId: operation.stopId },
    })
    result.ordersAttached += attached.count

    if (
      operation.cancellation !== 'UNCHANGED' ||
      operation.reopenCompletion ||
      attached.count > 0
    ) {
      const data: {
        version: { increment: number }
        cancelledAt?: Date | null
        deliveredAt?: null
        completionMethod?: null
      } = { version: { increment: 1 } }
      if (operation.cancellation === 'CANCEL') {
        data.cancelledAt = input.now
        result.stopsCancelled += 1
      }
      if (operation.cancellation === 'REOPEN') {
        data.cancelledAt = null
        result.stopsReopened += 1
      }
      if (operation.reopenCompletion) {
        data.deliveredAt = null
        data.completionMethod = null
        result.deliveredStopsReopened += 1
      }
      await tx.courierRouteStop.update({
        where: { id: operation.stopId },
        data,
      })
    }

    if (operation.reopenRouteDayId) {
      await reopenRouteDay(tx, operation.reopenRouteDayId, input.now)
      result.routeDaysReopened += 1
      result.routeDaysChanged += 1
    } else if (operation.touchRouteDayId) {
      await touchRouteDay(tx, operation.touchRouteDayId, input.now)
      result.routeDaysChanged += 1
    }
  }

  return result
}

async function reopenRouteDay(
  tx: RouteMaterializerTransaction,
  routeDayId: string,
  now: Date,
): Promise<void> {
  await tx.courierRouteDay.update({
    where: { id: routeDayId },
    data: { completedAt: null, routeChangedAt: now },
  })
}

async function touchRouteDay(
  tx: RouteMaterializerTransaction,
  routeDayId: string,
  now: Date,
): Promise<void> {
  await tx.courierRouteDay.update({
    where: { id: routeDayId },
    data: { routeChangedAt: now },
  })
}

/** Idempotent materializer entry point; callers may safely invoke it before reads. */
export async function ensureCourierRouteStopsForDate(
  date: Date,
  now: Date = new Date(),
): Promise<RouteMaterializationResult> {
  const { prismaDirect } = await import('@/lib/db/prisma-direct')
  const deliveryDate = normalizeMskDeliveryDate(date)
  return runWithPrismaConflictRetry(() =>
    prismaDirect.$transaction(
      (tx) =>
        ensureCourierRouteStopsForDateInTransaction(
          tx as unknown as RouteMaterializerTransaction,
          { deliveryDate, now },
        ),
      ROUTE_TRANSACTION_OPTIONS,
    ),
  )
}
