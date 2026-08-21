import type {
  DeliveryGeoResult,
  DeliveryOverrideStatus,
  MealType,
  PackagingType,
  Prisma,
  UserRole,
} from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  compareRouteStops,
  getRouteState,
  getStopState,
  normalizeMskDeliveryDate,
  type CourierRouteState,
  type CourierRouteStopState,
} from '@/lib/delivery/route-domain'

export interface CourierRouteReadActor {
  id: string
  role: UserRole
}

export class CourierRouteReadAccessError extends Error {
  override name = 'CourierRouteReadAccessError'
  constructor() {
    super('Остановка недоступна или не найдена.')
  }
}

export interface CourierRouteStopItemView {
  orderId: string
  mealType: MealType
  portions: number
  packaging: PackagingType
  tags: string[]
  notes: string | null
}

export interface CourierRouteStopView {
  id: string
  routeDayId: string
  deliveryDate: Date
  version: number
  state: CourierRouteStopState
  clientName: string
  locationName: string
  locationAddress: string
  contactName: string | null
  contactPhone: string | null
  contactNotes: string | null
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  deliveryInstructions: string | null
  assignedAt: Date
  deliveredAt: Date | null
  completionMethod: string | null
  totalPortions: number
  items: CourierRouteStopItemView[]
  tags: string[]
  notes: string[]
  geofence: {
    enabled: boolean
    radiusM: number
    hasCoordinates: boolean
  }
  latestGeoAttempt: {
    id: string
    result: DeliveryGeoResult
    distanceM: number | null
    accuracyM: number | null
    createdAt: Date
    overrideRequestId: string | null
  } | null
  override: {
    id: string
    status: DeliveryOverrideStatus
    expiresAt: Date
    createdAt: Date
    resolutionComment: string | null
  } | null
  route: {
    id: string
    started: boolean
    completed: boolean
  }
}

export interface CourierRouteDayView {
  id: string
  deliveryDate: Date
  courierName: string
  startedAt: Date | null
  completedAt: Date | null
  routeChangedAt: Date | null
  state: CourierRouteState
  totalStops: number
  deliveredStops: number
  remainingStops: number
  totalPortions: number
  deliveredPortions: number
  nextStop: CourierRouteStopView | null
  otherStops: CourierRouteStopView[]
  completedStops: CourierRouteStopView[]
  newStops: CourierRouteStopView[]
  hasRouteChanges: boolean
}

const STOP_SELECT = {
  id: true,
  routeDayId: true,
  deliveryDate: true,
  clientId: true,
  locationId: true,
  assignmentMode: true,
  clientNameSnapshot: true,
  locationNameSnapshot: true,
  locationAddressSnapshot: true,
  contactNameSnapshot: true,
  contactPhoneSnapshot: true,
  contactNotesSnapshot: true,
  deliveryWindowFromSnapshot: true,
  deliveryWindowToSnapshot: true,
  deliveryInstructionsSnapshot: true,
  latitudeSnapshot: true,
  longitudeSnapshot: true,
  geofenceRadiusMSnapshot: true,
  geofenceEnabledSnapshot: true,
  assignedAt: true,
  deliveredAt: true,
  completionMethod: true,
  cancelledAt: true,
  version: true,
  orders: {
    where: { status: { not: 'CANCELLED' as const } },
    select: {
      id: true,
      status: true,
      mealType: true,
      portions: true,
      packaging: true,
      tags: true,
      notes: true,
    },
  },
  deliveryGeoAttempts: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      result: true,
      distanceM: true,
      accuracyM: true,
      createdAt: true,
      overrideRequest: { select: { id: true } },
    },
  },
  deliveryOverrideRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      resolutionComment: true,
    },
  },
} satisfies Prisma.CourierRouteStopSelect

const STOP_DETAIL_SELECT = {
  ...STOP_SELECT,
  routeDay: {
    select: {
      id: true,
      courierId: true,
      startedAt: true,
      completedAt: true,
    },
  },
} satisfies Prisma.CourierRouteStopSelect

type StopRow = Prisma.CourierRouteStopGetPayload<{ select: typeof STOP_SELECT }>
type StopDetailRow = Prisma.CourierRouteStopGetPayload<{ select: typeof STOP_DETAIL_SELECT }>

function numericValue(value: Prisma.Decimal | number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : value.toNumber()
}

function computedOverrideStatus(
  status: DeliveryOverrideStatus,
  expiresAt: Date,
  now: Date,
): DeliveryOverrideStatus {
  return status === 'PENDING' && expiresAt.getTime() <= now.getTime()
    ? 'EXPIRED'
    : status
}

function toStopView(
  stop: StopRow,
  route: { id: string; startedAt: Date | null; completedAt: Date | null },
  now: Date,
): CourierRouteStopView {
  const items = stop.orders.map((item) => ({
    orderId: item.id,
    mealType: item.mealType,
    portions: item.portions,
    packaging: item.packaging,
    tags: item.tags,
    notes: item.notes,
  }))
  const latestAttempt = stop.deliveryGeoAttempts[0] ?? null
  const latestOverride = stop.deliveryOverrideRequests[0] ?? null

  return {
    id: stop.id,
    routeDayId: stop.routeDayId ?? route.id,
    deliveryDate: stop.deliveryDate,
    version: stop.version,
    state: getStopState({
      deliveryDate: stop.deliveryDate,
      deliveryWindowToSnapshot: stop.deliveryWindowToSnapshot,
      deliveredAt: stop.deliveredAt,
      cancelledAt: stop.cancelledAt,
      assignedAt: stop.assignedAt,
    }, route, now),
    clientName: stop.clientNameSnapshot,
    locationName: stop.locationNameSnapshot,
    locationAddress: stop.locationAddressSnapshot,
    contactName: stop.contactNameSnapshot,
    contactPhone: stop.contactPhoneSnapshot,
    contactNotes: stop.contactNotesSnapshot,
    deliveryWindowFrom: stop.deliveryWindowFromSnapshot,
    deliveryWindowTo: stop.deliveryWindowToSnapshot,
    deliveryInstructions: stop.deliveryInstructionsSnapshot,
    assignedAt: stop.assignedAt,
    deliveredAt: stop.deliveredAt,
    completionMethod: stop.completionMethod,
    totalPortions: items.reduce((sum, item) => sum + item.portions, 0),
    items,
    tags: [...new Set(items.flatMap((item) => item.tags))],
    notes: [...new Set(items.map((item) => item.notes).filter((note): note is string => Boolean(note)))],
    geofence: {
      enabled: stop.geofenceEnabledSnapshot,
      radiusM: stop.geofenceRadiusMSnapshot,
      hasCoordinates: stop.latitudeSnapshot !== null && stop.longitudeSnapshot !== null,
    },
    latestGeoAttempt: latestAttempt
      ? {
          id: latestAttempt.id,
          result: latestAttempt.result,
          distanceM: numericValue(latestAttempt.distanceM),
          accuracyM: numericValue(latestAttempt.accuracyM),
          createdAt: latestAttempt.createdAt,
          overrideRequestId: latestAttempt.overrideRequest?.id ?? null,
        }
      : null,
    override: latestOverride
      ? {
          id: latestOverride.id,
          status: computedOverrideStatus(latestOverride.status, latestOverride.expiresAt, now),
          expiresAt: latestOverride.expiresAt,
          createdAt: latestOverride.createdAt,
          resolutionComment: latestOverride.resolutionComment,
        }
      : null,
    route: {
      id: route.id,
      started: Boolean(route.startedAt),
      completed: Boolean(route.completedAt),
    },
  }
}

function assertCourier(actor: CourierRouteReadActor): void {
  if (actor.role !== 'COURIER') throw new CourierRouteReadAccessError()
}

/** Read-only: safe to call from the 30-second visible-document refresh. */
export async function getOwnCourierRouteDay(
  actor: CourierRouteReadActor,
  deliveryDate: Date,
  now = new Date(),
): Promise<CourierRouteDayView | null> {
  assertCourier(actor)
  const exactDate = normalizeMskDeliveryDate(deliveryDate)
  const route = await prisma.courierRouteDay.findFirst({
    where: { courierId: actor.id, deliveryDate: exactDate },
    select: {
      id: true,
      courierId: true,
      courierNameSnapshot: true,
      deliveryDate: true,
      startedAt: true,
      completedAt: true,
      routeChangedAt: true,
      stops: { select: STOP_SELECT },
    },
  })
  if (!route) return null

  const routeState = getRouteState(route)
  const routeRef = {
    id: route.id,
    startedAt: route.startedAt,
    completedAt: route.completedAt,
  }
  const visibleStops = route.stops
    .filter((stop) => !stop.cancelledAt)
    .sort(compareRouteStops)
    .map((stop) => toStopView(stop, routeRef, now))
  const openStops = visibleStops.filter((stop) => stop.state !== 'DELIVERED')
  const completedStops = visibleStops.filter((stop) => stop.state === 'DELIVERED')
  const newStops = openStops.filter((stop) => stop.state === 'NEW')

  return {
    id: route.id,
    deliveryDate: route.deliveryDate,
    courierName: route.courierNameSnapshot,
    startedAt: route.startedAt,
    completedAt: route.completedAt,
    routeChangedAt: route.routeChangedAt,
    state: routeState,
    totalStops: visibleStops.length,
    deliveredStops: completedStops.length,
    remainingStops: openStops.length,
    totalPortions: visibleStops.reduce((sum, stop) => sum + stop.totalPortions, 0),
    deliveredPortions: completedStops.reduce((sum, stop) => sum + stop.totalPortions, 0),
    nextStop: openStops[0] ?? null,
    otherStops: openStops.slice(1),
    completedStops,
    newStops,
    hasRouteChanges: newStops.length > 0,
  }
}

/** Read-only and own-only; the relational filter closes stop-ID IDOR. */
export async function getOwnCourierRouteStop(
  actor: CourierRouteReadActor,
  stopId: string,
  now = new Date(),
): Promise<CourierRouteStopView> {
  assertCourier(actor)
  const stop = await prisma.courierRouteStop.findFirst({
    where: {
      id: stopId,
      assignmentMode: 'IN_HOUSE',
      routeDay: { courierId: actor.id },
    },
    select: STOP_DETAIL_SELECT,
  })
  if (!stop || !stop.routeDay || !stop.routeDayId) {
    throw new CourierRouteReadAccessError()
  }
  return toStopView(stop as StopDetailRow, stop.routeDay, now)
}
