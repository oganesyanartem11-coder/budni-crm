import type {
  CourierStopCompletionMethod,
  DeliveryGeoResult,
  OrderStatus,
  UserRole,
} from '@prisma/client'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import {
  evaluateDeliveryGeofence,
  type DeliveryGeofenceInput,
} from './geofence'
import { runWithPrismaConflictRetry } from './prisma-transaction-retry'

export const ACTIVE_ROUTE_ORDER_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
]

const ACTIVE_ROUTE_ORDER_STATUS_SET = new Set<OrderStatus>(ACTIVE_ROUTE_ORDER_STATUSES)

export interface RouteStopCompletionActor {
  id: string
  name: string
  role: UserRole
}

export interface RouteStopPositionInput {
  latitude: number | null
  longitude: number | null
  accuracyM: number | null
  capturedAt: Date | null
}

export interface CompleteRouteStopInput {
  stopId: string
  expectedVersion: number
  requestId: string
  position: RouteStopPositionInput | null
  now: Date
}

export interface RouteStopGeoAttemptResult {
  id: string
  result: DeliveryGeoResult
  distanceM: number | null
}

export interface CompleteRouteStopResult {
  stopId: string
  delivered: boolean
  idempotent: boolean
  version: number
  completionMethod: CourierStopCompletionMethod | null
  geoAttempt: RouteStopGeoAttemptResult
}

export class RouteStopAccessError extends Error {
  override name = 'RouteStopAccessError'
  constructor(message = 'Остановка недоступна или не найдена.') {
    super(message)
  }
}

export class RouteStopNotStartedError extends Error {
  override name = 'RouteStopNotStartedError'
  constructor() {
    super('Сначала начните маршрут.')
  }
}

export class RouteStopDateError extends Error {
  override name = 'RouteStopDateError'
  constructor() {
    super('Курьер может подтвердить только доставку за сегодня.')
  }
}

export class RouteStopCancelledError extends Error {
  override name = 'RouteStopCancelledError'
  constructor() {
    super('Отменённую остановку нельзя завершить.')
  }
}

export class RouteStopVersionError extends Error {
  override name = 'RouteStopVersionError'
  constructor() {
    super('Остановка изменилась. Обновите страницу и повторите попытку.')
  }
}

export class RouteStopNoActiveOrdersError extends Error {
  override name = 'RouteStopNoActiveOrdersError'
  constructor() {
    super('В остановке нет активных заказов.')
  }
}

type NumericValue = number | { toNumber(): number }

interface CompletionOrderRow {
  id: string
  status: OrderStatus
  delivery: { id: string } | null
}

interface CompletionStopRow {
  id: string
  deliveryDate: Date
  version: number
  assignmentMode: 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'
  deliveredAt: Date | null
  completionMethod: CourierStopCompletionMethod | null
  cancelledAt: Date | null
  geofenceEnabledSnapshot: boolean
  latitudeSnapshot: NumericValue | null
  longitudeSnapshot: NumericValue | null
  geofenceRadiusMSnapshot: number
  routeDay: {
    id: string
    courierId: string
    startedAt: Date | null
    completedAt: Date | null
  } | null
  orders: CompletionOrderRow[]
  geoAttempts: Array<{
    id: string
    result: DeliveryGeoResult
    distanceM: NumericValue | null
  }>
}

interface CompletionTransaction {
  courierRouteStop: {
    findUnique(args: unknown): Promise<CompletionStopRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  deliveryGeoAttempt: {
    create(args: unknown): Promise<{
      id: string
      result: DeliveryGeoResult
      distanceM: NumericValue | null
    }>
  }
  order: {
    updateMany(args: unknown): Promise<{ count: number }>
  }
  delivery: {
    upsert(args: unknown): Promise<unknown>
  }
  courierRouteDay: {
    updateMany(args: unknown): Promise<{ count: number }>
  }
  activityLog: {
    create(args: unknown): Promise<unknown>
  }
}

export interface FinalizeRouteStopDeliveryInput {
  stopId: string
  currentVersion: number
  expectedVersion: number
  routeDayId: string | null
  activeOrderIds: string[]
  actor: RouteStopCompletionActor
  now: Date
  completionMethod: CourierStopCompletionMethod
  legacyDeliveryType: 'IN_HOUSE' | 'EXTERNAL_COURIER'
  courierName: string
  activityAction: string
  activityPayload?: Record<string, unknown>
}

function toNumber(value: NumericValue | null): number | null {
  if (value === null) return null
  return typeof value === 'number' ? value : value.toNumber()
}

function toGeoAttemptResult(attempt: {
  id: string
  result: DeliveryGeoResult
  distanceM: NumericValue | null
}): RouteStopGeoAttemptResult {
  return {
    id: attempt.id,
    result: attempt.result,
    distanceM: toNumber(attempt.distanceM),
  }
}

function isStorableLatitude(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
    && value >= -90 && value <= 90
}

function isStorableLongitude(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
    && value >= -180 && value <= 180
}

function sameCalendarDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
}

function buildGeofenceInput(
  stop: CompletionStopRow,
  position: RouteStopPositionInput | null,
  now: Date,
): DeliveryGeofenceInput {
  return {
    courierLatitude: position?.latitude ?? null,
    courierLongitude: position?.longitude ?? null,
    accuracyM: position?.accuracyM ?? null,
    capturedAt: position?.capturedAt ?? null,
    receivedAt: now,
    targetLatitude: toNumber(stop.latitudeSnapshot),
    targetLongitude: toNumber(stop.longitudeSnapshot),
    radiusM: stop.geofenceRadiusMSnapshot,
  }
}

/** Shared atomic writer for courier, manager-direct and manager-override paths. */
export async function finalizeRouteStopDeliveryInTransaction(
  txValue: unknown,
  input: FinalizeRouteStopDeliveryInput,
): Promise<number> {
  const tx = txValue as CompletionTransaction
  const claimed = await tx.courierRouteStop.updateMany({
    where: {
      id: input.stopId,
      version: input.expectedVersion,
      deliveredAt: null,
      cancelledAt: null,
    },
    data: {
      deliveredAt: input.now,
      completionMethod: input.completionMethod,
      version: { increment: 1 },
    },
  })
  if (claimed.count !== 1) throw new RouteStopVersionError()

  const updatedOrders = await tx.order.updateMany({
    where: {
      id: { in: input.activeOrderIds },
      status: { in: ACTIVE_ROUTE_ORDER_STATUSES },
    },
    data: { status: 'DELIVERED' },
  })
  if (updatedOrders.count !== input.activeOrderIds.length) {
    throw new RouteStopVersionError()
  }

  for (const orderId of input.activeOrderIds) {
    await tx.delivery.upsert({
      where: { orderId },
      create: {
        orderId,
        type: input.legacyDeliveryType,
        courierName: input.courierName,
        status: 'DELIVERED',
        deliveredAt: input.now,
      },
      update: {
        type: input.legacyDeliveryType,
        courierName: input.courierName,
        status: 'DELIVERED',
        deliveredAt: input.now,
      },
    })
  }

  const resultingVersion = input.currentVersion + 1
  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: input.activityAction,
      entityType: 'CourierRouteStop',
      entityId: input.stopId,
      payload: {
        orderIds: input.activeOrderIds,
        completionMethod: input.completionMethod,
        resultingVersion,
        ...input.activityPayload,
      },
    },
  })

  if (input.routeDayId) {
    await tx.courierRouteDay.updateMany({
      where: {
        id: input.routeDayId,
        startedAt: { not: null },
        completedAt: null,
        stops: { none: { deliveredAt: null, cancelledAt: null } },
      },
      data: { completedAt: input.now },
    })
  }

  return resultingVersion
}

async function createGeoAttempt(
  tx: CompletionTransaction,
  stop: CompletionStopRow,
  actor: RouteStopCompletionActor,
  input: CompleteRouteStopInput,
): Promise<RouteStopGeoAttemptResult> {
  const evaluation = stop.geofenceEnabledSnapshot
    ? evaluateDeliveryGeofence(buildGeofenceInput(stop, input.position, input.now))
    : { result: 'GEOFENCE_NOT_REQUIRED' as const, distanceM: null }
  const hasValidRawPair = isStorableLatitude(input.position?.latitude)
    && isStorableLongitude(input.position?.longitude)

  const attempt = await tx.deliveryGeoAttempt.create({
    data: {
      stopId: stop.id,
      courierId: actor.id,
      requestId: input.requestId,
      courierNameSnapshot: actor.name,
      courierLatitude: stop.geofenceEnabledSnapshot && hasValidRawPair
        ? input.position!.latitude
        : null,
      courierLongitude: stop.geofenceEnabledSnapshot && hasValidRawPair
        ? input.position!.longitude
        : null,
      accuracyM:
        stop.geofenceEnabledSnapshot
        && input.position?.accuracyM !== null
        && input.position?.accuracyM !== undefined
        && Number.isFinite(input.position.accuracyM)
        && input.position.accuracyM >= 0
          ? input.position.accuracyM
          : null,
      targetLatitudeSnapshot: stop.latitudeSnapshot,
      targetLongitudeSnapshot: stop.longitudeSnapshot,
      targetRadiusMSnapshot: stop.geofenceRadiusMSnapshot,
      capturedAt: stop.geofenceEnabledSnapshot ? input.position?.capturedAt ?? null : null,
      receivedAt: input.now,
      distanceM: evaluation.distanceM,
      result: evaluation.result,
    },
    select: { id: true, result: true, distanceM: true },
  })
  return toGeoAttemptResult(attempt)
}

/**
 * Transaction-only completion core. It receives an explicit authenticated
 * actor and never reads cookies, revalidates caches or performs network calls.
 */
export async function completeRouteStopInTransaction(
  txValue: unknown,
  actor: RouteStopCompletionActor,
  input: CompleteRouteStopInput,
): Promise<CompleteRouteStopResult> {
  if (actor.role !== 'COURIER') throw new RouteStopAccessError()
  const tx = txValue as CompletionTransaction
  const stop = await tx.courierRouteStop.findUnique({
    where: { id: input.stopId },
    select: {
      id: true,
      deliveryDate: true,
      version: true,
      assignmentMode: true,
      deliveredAt: true,
      completionMethod: true,
      cancelledAt: true,
      geofenceEnabledSnapshot: true,
      latitudeSnapshot: true,
      longitudeSnapshot: true,
      geofenceRadiusMSnapshot: true,
      routeDay: {
        select: {
          id: true,
          courierId: true,
          startedAt: true,
          completedAt: true,
        },
      },
      orders: {
        where: {
          status: { in: [...ACTIVE_ROUTE_ORDER_STATUSES, 'DELIVERED'] },
        },
        select: {
          id: true,
          status: true,
          delivery: { select: { id: true } },
        },
      },
      geoAttempts: {
        where: { requestId: input.requestId },
        select: { id: true, result: true, distanceM: true },
        take: 1,
      },
    },
  })

  if (
    !stop
    || stop.assignmentMode !== 'IN_HOUSE'
    || !stop.routeDay
    || stop.routeDay.courierId !== actor.id
  ) {
    throw new RouteStopAccessError()
  }
  if (!stop.routeDay.startedAt) throw new RouteStopNotStartedError()
  const today = getMskCalendarDayUtc(input.now, 0)
  if (!sameCalendarDate(stop.deliveryDate, today)) throw new RouteStopDateError()
  if (stop.cancelledAt) throw new RouteStopCancelledError()

  const existingAttempt = stop.geoAttempts[0]
  if (stop.deliveredAt && stop.completionMethod) {
    return {
      stopId: stop.id,
      delivered: true,
      idempotent: true,
      version: stop.version,
      completionMethod: stop.completionMethod,
      geoAttempt: existingAttempt
        ? toGeoAttemptResult(existingAttempt)
        : {
            id: '',
            result: stop.completionMethod === 'GEOFENCE'
              ? 'ALLOWED'
              : 'GEOFENCE_NOT_REQUIRED',
            distanceM: null,
          },
    }
  }
  if (stop.version !== input.expectedVersion) throw new RouteStopVersionError()

  const activeOrders = stop.orders.filter((order) =>
    ACTIVE_ROUTE_ORDER_STATUS_SET.has(order.status),
  )
  if (activeOrders.length === 0) throw new RouteStopNoActiveOrdersError()

  const geoAttempt = existingAttempt
    ? toGeoAttemptResult(existingAttempt)
    : await createGeoAttempt(tx, stop, actor, input)
  if (
    stop.geofenceEnabledSnapshot
    && geoAttempt.result !== 'ALLOWED'
  ) {
    return {
      stopId: stop.id,
      delivered: false,
      idempotent: Boolean(existingAttempt),
      version: stop.version,
      completionMethod: null,
      geoAttempt,
    }
  }

  const completionMethod: CourierStopCompletionMethod = stop.geofenceEnabledSnapshot
    ? 'GEOFENCE'
    : 'COURIER_DIRECT'
  const activeOrderIds = activeOrders.map((order) => order.id)
  const resultingVersion = await finalizeRouteStopDeliveryInTransaction(tx, {
    stopId: stop.id,
    currentVersion: stop.version,
    expectedVersion: input.expectedVersion,
    routeDayId: stop.routeDay.id,
    activeOrderIds,
    actor,
    now: input.now,
    completionMethod,
    legacyDeliveryType: 'IN_HOUSE',
    courierName: actor.name,
    activityAction: 'COURIER_ROUTE_STOP_DELIVERED',
    activityPayload: {
        geoAttemptId: geoAttempt.id,
        geoResult: geoAttempt.result,
        distanceM: geoAttempt.distanceM,
    },
  })

  return {
    stopId: stop.id,
    delivered: true,
    idempotent: false,
    version: resultingVersion,
    completionMethod,
    geoAttempt,
  }
}

/** Public Core with explicit actor; wrappers own auth/cookies/revalidation. */
export async function completeRouteStopCore(
  actor: RouteStopCompletionActor,
  input: CompleteRouteStopInput,
): Promise<CompleteRouteStopResult> {
  const { prismaDirect } = await import('@/lib/db/prisma-direct')
  return runWithPrismaConflictRetry(() =>
    prismaDirect.$transaction(
      (tx) => completeRouteStopInTransaction(tx, actor, input),
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 10_000 },
    ),
  )
}
