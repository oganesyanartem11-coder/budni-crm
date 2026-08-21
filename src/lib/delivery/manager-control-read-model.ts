import type {
  CourierAssignmentMode,
  DeliveryGeoResult,
  DeliveryOverrideStatus,
  MealType,
  PackagingType,
  Prisma,
  UserRole,
} from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  summarizeDeliveryAnalytics,
  type DeliveryAnalyticsSummary,
} from '@/lib/delivery/delivery-analytics'
import { getDeliveryGeoResultLabel } from '@/lib/delivery/delivery-geo-labels'
import {
  compareRouteStops,
  getRouteState,
  getStopState,
  normalizeMskDeliveryDate,
  type CourierRouteState,
  type CourierRouteStopState,
} from '@/lib/delivery/route-domain'

export interface ManagerDeliveryControlActor {
  id: string
  role: UserRole
}

export class ManagerDeliveryControlAccessError extends Error {
  override name = 'ManagerDeliveryControlAccessError'
  constructor(message = 'Маршрут недоступен или не найден.') {
    super(message)
  }
}

export interface ManagerControlSummary {
  workingCouriers: number
  totalStops: number
  deliveredStops: number
  activeLateStops: number
  externalStops: number
  unassignedStops: number
  pendingOverrides: number
}

export interface ManagerStopSummaryView {
  id: string
  routeDayId: string | null
  version: number
  state: CourierRouteStopState
  assignmentMode: CourierAssignmentMode
  clientName: string
  locationName: string
  locationAddress: string
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  assignedAt: Date
  deliveredAt: Date | null
  totalPortions: number
  pendingOverride: boolean
}

export type ManagerLastActionKind =
  | 'ROUTE_STARTED'
  | 'STOP_DELIVERED'
  | 'GPS_CHECK'
  | 'OVERRIDE_REQUESTED'

export interface ManagerLastActionView {
  kind: ManagerLastActionKind
  at: Date
  stopId: string | null
  locationName: string | null
}

export interface ManagerCourierCardView {
  routeDayId: string
  courierId: string
  courierName: string
  initials: string
  state: CourierRouteState
  startedAt: Date | null
  completedAt: Date | null
  totalStops: number
  deliveredStops: number
  remainingStops: number
  activeLateStops: number
  newStops: number
  pendingOverrides: number
  nextStop: ManagerStopSummaryView | null
  lastAction: ManagerLastActionView | null
}

export interface ManagerDeliveryControlView {
  deliveryDate: Date
  summary: ManagerControlSummary
  couriers: ManagerCourierCardView[]
  externalStops: ManagerStopSummaryView[]
  unassignedStops: ManagerStopSummaryView[]
}

export interface ManagerCourierOption {
  id: string
  name: string
}

export interface ManagerGeoAttemptView {
  id: string
  result: DeliveryGeoResult
  distanceM: number | null
  accuracyM: number | null
  receivedAt: Date
}

export interface ManagerOverrideView {
  id: string
  geoAttemptId: string
  status: DeliveryOverrideStatus
  comment: string
  expiresAt: Date
  createdAt: Date
  resolvedAt: Date | null
  resolvedByName: string | null
  resolutionComment: string | null
}

export interface ManagerStopOrderItemView {
  id: string
  mealType: MealType
  portions: number
  packaging: PackagingType
  tags: string[]
  notes: string | null
}

export type ManagerTimelineKind =
  | 'ASSIGNED'
  | 'ROUTE_STARTED'
  | 'GPS_CHECK'
  | 'OVERRIDE_REQUESTED'
  | 'OVERRIDE_RESOLVED'
  | 'DELIVERED'

export interface ManagerTimelineEventView {
  id: string
  kind: ManagerTimelineKind
  at: Date
  title: string
  detail: string | null
}

export interface ManagerStopDetailView extends ManagerStopSummaryView {
  contactName: string | null
  contactPhone: string | null
  contactNotes: string | null
  deliveryInstructions: string | null
  geofenceEnabled: boolean
  geofenceRadiusM: number
  items: ManagerStopOrderItemView[]
  latestGeoAttempt: ManagerGeoAttemptView | null
  override: ManagerOverrideView | null
  timeline: ManagerTimelineEventView[]
}

export interface ManagerCourierRouteDetailView {
  route: ManagerCourierCardView
  stops: ManagerStopSummaryView[]
  selectedStop: ManagerStopDetailView | null
  couriers: ManagerCourierOption[]
}

const CONTROL_STOP_SELECT = {
  id: true,
  routeDayId: true,
  deliveryDate: true,
  assignmentMode: true,
  assignmentSource: true,
  assignedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  completionMethod: true,
  version: true,
  clientNameSnapshot: true,
  locationNameSnapshot: true,
  locationAddressSnapshot: true,
  contactNameSnapshot: true,
  contactPhoneSnapshot: true,
  contactNotesSnapshot: true,
  deliveryWindowFromSnapshot: true,
  deliveryWindowToSnapshot: true,
  deliveryInstructionsSnapshot: true,
  geofenceEnabledSnapshot: true,
  geofenceRadiusMSnapshot: true,
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
    orderBy: { receivedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      result: true,
      distanceM: true,
      accuracyM: true,
      receivedAt: true,
    },
  },
  deliveryOverrideRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      geoAttemptId: true,
      status: true,
      comment: true,
      expiresAt: true,
      createdAt: true,
      resolvedAt: true,
      resolvedByNameSnapshot: true,
      resolutionComment: true,
    },
  },
} satisfies Prisma.CourierRouteStopSelect

const DETAIL_STOP_SELECT = {
  ...CONTROL_STOP_SELECT,
  deliveryGeoAttempts: {
    orderBy: { receivedAt: 'desc' as const },
    take: 20,
    select: CONTROL_STOP_SELECT.deliveryGeoAttempts.select,
  },
  deliveryOverrideRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    select: CONTROL_STOP_SELECT.deliveryOverrideRequests.select,
  },
} satisfies Prisma.CourierRouteStopSelect

const ANALYTICS_STOP_SELECT = {
  id: true,
  deliveryDate: true,
  assignmentMode: true,
  cancelledAt: true,
  deliveredAt: true,
  deliveryWindowToSnapshot: true,
  completionMethod: true,
  routeDay: {
    select: {
      courierId: true,
      courierNameSnapshot: true,
    },
  },
} satisfies Prisma.CourierRouteStopSelect

type ControlStopRow = Prisma.CourierRouteStopGetPayload<{
  select: typeof CONTROL_STOP_SELECT
}>
type DetailStopRow = Prisma.CourierRouteStopGetPayload<{
  select: typeof DETAIL_STOP_SELECT
}>

interface RouteRef {
  id: string
  courierId: string
  courierNameSnapshot: string
  startedAt: Date | null
  completedAt: Date | null
}

function assertManager(actor: ManagerDeliveryControlActor): void {
  if (!['ADMIN_PRO', 'ADMIN', 'MANAGER'].includes(actor.role)) {
    throw new ManagerDeliveryControlAccessError()
  }
}

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

function toOverrideView(
  request: ControlStopRow['deliveryOverrideRequests'][number] | undefined,
  now: Date,
): ManagerOverrideView | null {
  if (!request) return null
  return {
    id: request.id,
    geoAttemptId: request.geoAttemptId,
    status: computedOverrideStatus(request.status, request.expiresAt, now),
    comment: request.comment,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
    resolvedByName: request.resolvedByNameSnapshot ?? null,
    resolutionComment: request.resolutionComment,
  }
}

function toStopSummary(
  stop: ControlStopRow,
  route: RouteRef | null,
  now: Date,
): ManagerStopSummaryView {
  const override = toOverrideView(stop.deliveryOverrideRequests[0], now)
  return {
    id: stop.id,
    routeDayId: stop.routeDayId,
    version: stop.version,
    state: getStopState({
      deliveryDate: stop.deliveryDate,
      deliveryWindowToSnapshot: stop.deliveryWindowToSnapshot,
      assignedAt: stop.assignedAt,
      deliveredAt: stop.deliveredAt,
      cancelledAt: stop.cancelledAt,
    }, { startedAt: route?.startedAt ?? null }, now),
    assignmentMode: stop.assignmentMode,
    clientName: stop.clientNameSnapshot,
    locationName: stop.locationNameSnapshot,
    locationAddress: stop.locationAddressSnapshot,
    deliveryWindowFrom: stop.deliveryWindowFromSnapshot,
    deliveryWindowTo: stop.deliveryWindowToSnapshot,
    assignedAt: stop.assignedAt,
    deliveredAt: stop.deliveredAt,
    totalPortions: stop.orders.reduce((sum, order) => sum + order.portions, 0),
    pendingOverride: override?.status === 'PENDING',
  }
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'К'
}

function latestRealAction(
  route: RouteRef,
  stops: ControlStopRow[],
): ManagerLastActionView | null {
  const actions: ManagerLastActionView[] = []
  if (route.startedAt) {
    actions.push({
      kind: 'ROUTE_STARTED',
      at: route.startedAt,
      stopId: null,
      locationName: null,
    })
  }
  for (const stop of stops) {
    if (stop.deliveredAt) {
      actions.push({
        kind: 'STOP_DELIVERED',
        at: stop.deliveredAt,
        stopId: stop.id,
        locationName: stop.locationNameSnapshot,
      })
    }
    const geo = stop.deliveryGeoAttempts[0]
    if (geo) {
      actions.push({
        kind: 'GPS_CHECK',
        at: geo.receivedAt,
        stopId: stop.id,
        locationName: stop.locationNameSnapshot,
      })
    }
    const override = stop.deliveryOverrideRequests[0]
    if (override) {
      actions.push({
        kind: 'OVERRIDE_REQUESTED',
        at: override.createdAt,
        stopId: stop.id,
        locationName: stop.locationNameSnapshot,
      })
    }
  }
  return actions.sort((left, right) => right.at.getTime() - left.at.getTime())[0] ?? null
}

function toCourierCard(
  route: RouteRef & { stops: ControlStopRow[] },
  now: Date,
): ManagerCourierCardView {
  const orderedRows = [...route.stops].sort(compareRouteStops)
  const stops = orderedRows.map((stop) => toStopSummary(stop, route, now))
  const openStops = stops.filter((stop) => stop.state !== 'DELIVERED')
  const deliveredStops = stops.filter((stop) => stop.state === 'DELIVERED')
  return {
    routeDayId: route.id,
    courierId: route.courierId,
    courierName: route.courierNameSnapshot,
    initials: initials(route.courierNameSnapshot),
    state: getRouteState(route),
    startedAt: route.startedAt,
    completedAt: route.completedAt,
    totalStops: stops.length,
    deliveredStops: deliveredStops.length,
    remainingStops: openStops.length,
    activeLateStops: openStops.filter((stop) => stop.state === 'LATE').length,
    newStops: openStops.filter((stop) => stop.state === 'NEW').length,
    pendingOverrides: stops.filter((stop) => stop.pendingOverride).length,
    nextStop: openStops[0] ?? null,
    lastAction: latestRealAction(route, orderedRows),
  }
}

function sortCourierCards(
  left: ManagerCourierCardView,
  right: ManagerCourierCardView,
): number {
  return right.activeLateStops - left.activeLateStops
    || right.pendingOverrides - left.pendingOverrides
    || right.remainingStops - left.remainingStops
    || left.courierName.localeCompare(right.courierName, 'ru')
}

export async function getManagerDeliveryControl(
  actor: ManagerDeliveryControlActor,
  deliveryDate: Date,
  now = new Date(),
): Promise<ManagerDeliveryControlView> {
  assertManager(actor)
  const exactDate = normalizeMskDeliveryDate(deliveryDate)
  const [routeDays, nonHouseRows] = await Promise.all([
    prisma.courierRouteDay.findMany({
      where: { deliveryDate: exactDate },
      select: {
        id: true,
        courierId: true,
        courierNameSnapshot: true,
        deliveryDate: true,
        startedAt: true,
        completedAt: true,
        routeChangedAt: true,
        stops: {
          where: { cancelledAt: null },
          select: CONTROL_STOP_SELECT,
        },
      },
    }),
    prisma.courierRouteStop.findMany({
      where: {
        deliveryDate: exactDate,
        cancelledAt: null,
        assignmentMode: { in: ['EXTERNAL', 'UNASSIGNED'] },
      },
      select: CONTROL_STOP_SELECT,
    }),
  ])

  const couriers = routeDays.map((route) => toCourierCard(route, now)).sort(sortCourierCards)
  const externalStops = nonHouseRows
    .filter((stop) => stop.assignmentMode === 'EXTERNAL')
    .sort(compareRouteStops)
    .map((stop) => toStopSummary(stop, null, now))
  const unassignedStops = nonHouseRows
    .filter((stop) => stop.assignmentMode === 'UNASSIGNED')
    .sort(compareRouteStops)
    .map((stop) => toStopSummary(stop, null, now))
  const allStops = [
    ...routeDays.flatMap((route) => route.stops.map((stop) => toStopSummary(stop, route, now))),
    ...externalStops,
    ...unassignedStops,
  ]

  return {
    deliveryDate: exactDate,
    summary: {
      workingCouriers: routeDays.length,
      totalStops: allStops.length,
      deliveredStops: allStops.filter((stop) => stop.state === 'DELIVERED').length,
      activeLateStops: allStops.filter((stop) => stop.state === 'LATE').length,
      externalStops: externalStops.length,
      unassignedStops: unassignedStops.length,
      pendingOverrides: allStops.filter((stop) => stop.pendingOverride).length,
    },
    couriers,
    externalStops,
    unassignedStops,
  }
}

function timelineForStop(
  stop: DetailStopRow,
  route: RouteRef,
  now: Date,
): ManagerTimelineEventView[] {
  const events: ManagerTimelineEventView[] = [{
    id: `assigned-${stop.id}`,
    kind: 'ASSIGNED',
    at: stop.assignedAt,
    title: 'Точка назначена',
    detail: route.courierNameSnapshot,
  }]
  if (route.startedAt) {
    events.push({
      id: `started-${route.id}`,
      kind: 'ROUTE_STARTED',
      at: route.startedAt,
      title: 'Маршрут начат',
      detail: route.courierNameSnapshot,
    })
  }
  for (const attempt of stop.deliveryGeoAttempts) {
    const distance = numericValue(attempt.distanceM)
    events.push({
      id: `geo-${attempt.id}`,
      kind: 'GPS_CHECK',
      at: attempt.receivedAt,
      title: 'GPS-проверка',
      detail: distance === null
        ? getDeliveryGeoResultLabel(attempt.result)
        : `${getDeliveryGeoResultLabel(attempt.result)} · ${Math.round(distance)} м`,
    })
  }
  for (const request of stop.deliveryOverrideRequests) {
    const status = computedOverrideStatus(request.status, request.expiresAt, now)
    events.push({
      id: `override-request-${request.id}`,
      kind: 'OVERRIDE_REQUESTED',
      at: request.createdAt,
      title: 'Запрошено подтверждение менеджера',
      detail: request.comment,
    })
    if (request.resolvedAt || status === 'EXPIRED') {
      events.push({
        id: `override-result-${request.id}`,
        kind: 'OVERRIDE_RESOLVED',
        at: request.resolvedAt ?? request.expiresAt,
        title: `Override: ${status}`,
        detail: request.resolutionComment,
      })
    }
  }
  if (stop.deliveredAt) {
    events.push({
      id: `delivered-${stop.id}`,
      kind: 'DELIVERED',
      at: stop.deliveredAt,
      title: 'Доставка подтверждена',
      detail: stop.completionMethod,
    })
  }
  return events.sort((left, right) => right.at.getTime() - left.at.getTime())
}

function toStopDetail(
  stop: DetailStopRow,
  route: RouteRef,
  now: Date,
): ManagerStopDetailView {
  const summary = toStopSummary(stop, route, now)
  const latestGeo = stop.deliveryGeoAttempts[0]
  return {
    ...summary,
    contactName: stop.contactNameSnapshot,
    contactPhone: stop.contactPhoneSnapshot,
    contactNotes: stop.contactNotesSnapshot,
    deliveryInstructions: stop.deliveryInstructionsSnapshot,
    geofenceEnabled: stop.geofenceEnabledSnapshot,
    geofenceRadiusM: stop.geofenceRadiusMSnapshot,
    items: stop.orders.map((order) => ({
      id: order.id,
      mealType: order.mealType,
      portions: order.portions,
      packaging: order.packaging,
      tags: order.tags,
      notes: order.notes,
    })),
    latestGeoAttempt: latestGeo
      ? {
          id: latestGeo.id,
          result: latestGeo.result,
          distanceM: numericValue(latestGeo.distanceM),
          accuracyM: numericValue(latestGeo.accuracyM),
          receivedAt: latestGeo.receivedAt,
        }
      : null,
    override: toOverrideView(stop.deliveryOverrideRequests[0], now),
    timeline: timelineForStop(stop, route, now),
  }
}

export async function getManagerCourierRouteDetail(
  actor: ManagerDeliveryControlActor,
  routeDayId: string,
  requestedStopId: string | null,
  now = new Date(),
): Promise<ManagerCourierRouteDetailView | null> {
  assertManager(actor)
  const routeDay = await prisma.courierRouteDay.findFirst({
    where: { id: routeDayId },
    select: {
      id: true,
      courierId: true,
      courierNameSnapshot: true,
      deliveryDate: true,
      startedAt: true,
      completedAt: true,
      routeChangedAt: true,
      stops: {
        where: { cancelledAt: null },
        select: DETAIL_STOP_SELECT,
      },
    },
  })
  if (!routeDay) return null

  const couriers = await prisma.user.findMany({
    where: { role: 'COURIER', isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  const routeRef: RouteRef = routeDay
  const orderedRows = [...routeDay.stops].sort(compareRouteStops)
  const summaries = orderedRows.map((stop) => toStopSummary(stop, routeRef, now))
  const requested = requestedStopId
    ? orderedRows.find((stop) => stop.id === requestedStopId) ?? null
    : null
  const pendingOverrideStopId = summaries.find((stop) => stop.pendingOverride)?.id ?? null
  const selectedRow = requested
    ?? orderedRows.find((stop) => stop.id === pendingOverrideStopId)
    ?? orderedRows.find((stop) => !stop.deliveredAt)
    ?? orderedRows[0]
    ?? null

  return {
    route: toCourierCard({ ...routeDay, stops: routeDay.stops }, now),
    stops: summaries,
    selectedStop: selectedRow ? toStopDetail(selectedRow, routeRef, now) : null,
    couriers,
  }
}

export async function getManagerDeliveryAnalytics(
  actor: ManagerDeliveryControlActor,
  period: { from: Date; to: Date },
): Promise<DeliveryAnalyticsSummary> {
  assertManager(actor)
  const from = normalizeMskDeliveryDate(period.from)
  const to = normalizeMskDeliveryDate(period.to)
  const stops = await prisma.courierRouteStop.findMany({
    where: {
      deliveryDate: { gte: from, lte: to },
      cancelledAt: null,
    },
    select: ANALYTICS_STOP_SELECT,
  })
  return summarizeDeliveryAnalytics(stops)
}
