import type {
  CourierStopCompletionMethod,
  DeliveryGeoResult,
  DeliveryOverrideStatus,
  OrderStatus,
} from '@prisma/client'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import {
  ACTIVE_ROUTE_ORDER_STATUSES,
  RouteStopCancelledError,
  RouteStopNoActiveOrdersError,
  RouteStopVersionError,
  finalizeRouteStopDeliveryInTransaction,
  type RouteStopCompletionActor,
} from './route-completion'
import { runWithPrismaConflictRetry } from './prisma-transaction-retry'

const OVERRIDE_TTL_MS = 15 * 60_000
const ACTIVE_ROUTE_ORDER_STATUS_SET = new Set<OrderStatus>(ACTIVE_ROUTE_ORDER_STATUSES)
const MANAGER_ROLES = new Set(['ADMIN_PRO', 'ADMIN', 'MANAGER'])

export class DeliveryOverrideAccessError extends Error {
  override name = 'DeliveryOverrideAccessError'
  constructor(message = 'Запрос недоступен или уже неактуален.') {
    super(message)
  }
}

export class DeliveryOverrideCommentError extends Error {
  override name = 'DeliveryOverrideCommentError'
  constructor(message = 'Добавьте обязательный комментарий.') {
    super(message)
  }
}

interface OverrideStopRow {
  id: string
  deliveryDate: Date
  version: number
  assignmentMode: 'IN_HOUSE' | 'EXTERNAL' | 'UNASSIGNED'
  deliveredAt: Date | null
  completionMethod: CourierStopCompletionMethod | null
  cancelledAt: Date | null
  geofenceEnabledSnapshot: boolean
  routeDay: {
    id: string
    courierId: string
    courierNameSnapshot: string
    startedAt: Date | null
    completedAt: Date | null
  } | null
  orders: Array<{ id: string; status: OrderStatus }>
}

interface GeoAttemptRow {
  id: string
  stopId: string
  courierId: string
  result: DeliveryGeoResult
  distanceM: number | { toNumber(): number } | null
  stop: OverrideStopRow
  overrideRequest: {
    id: string
    status: DeliveryOverrideStatus
    expiresAt: Date
  } | null
}

interface OverrideRequestRow {
  id: string
  stopId: string
  geoAttemptId: string
  courierId: string
  courierNameSnapshot: string
  comment: string
  status: DeliveryOverrideStatus
  expiresAt: Date
  resolvedAt: Date | null
  resolvedById: string | null
  resolutionComment: string | null
  geoAttempt: GeoAttemptRow
  stop: OverrideStopRow
}

interface OverrideTransaction {
  deliveryGeoAttempt: {
    findUnique(args: unknown): Promise<GeoAttemptRow | null>
  }
  deliveryOverrideRequest: {
    findFirst(args: unknown): Promise<{
      id: string
      stopId: string
      status: DeliveryOverrideStatus
      expiresAt: Date
    } | null>
    findUnique(args: unknown): Promise<OverrideRequestRow | null>
    create(args: unknown): Promise<{
      id: string
      stopId: string
      status: DeliveryOverrideStatus
      expiresAt: Date
    }>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  courierRouteStop: {
    findUnique(args: unknown): Promise<OverrideStopRow | null>
    updateMany(args: unknown): Promise<{ count: number }>
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

export interface DeliveryOverrideRequestResult {
  requestId: string
  stopId: string
  status: 'PENDING'
  expiresAt: Date
  created: boolean
}

export interface ResolveDeliveryOverrideInput {
  requestId: string
  decision: 'APPROVE' | 'REJECT'
  comment: string | null
  now: Date
}

export interface ResolveDeliveryOverrideResult {
  requestId: string
  status: DeliveryOverrideStatus
  stopDelivered: boolean
  idempotent: boolean
}

function isManager(actor: RouteStopCompletionActor): boolean {
  return MANAGER_ROLES.has(actor.role)
}

function isSameMskDate(date: Date, now: Date): boolean {
  return date.getTime() === getMskCalendarDayUtc(now, 0).getTime()
}

function activeOrderIds(stop: OverrideStopRow): string[] {
  return stop.orders
    .filter((order) => ACTIVE_ROUTE_ORDER_STATUS_SET.has(order.status))
    .map((order) => order.id)
}

function assertOwnFailedAttempt(
  attempt: GeoAttemptRow | null,
  actor: RouteStopCompletionActor,
  stopId: string,
  now: Date,
): asserts attempt is GeoAttemptRow {
  if (
    !attempt
    || actor.role !== 'COURIER'
    || attempt.stopId !== stopId
    || attempt.courierId !== actor.id
    || attempt.result === 'ALLOWED'
    || attempt.result === 'GEOFENCE_NOT_REQUIRED'
    || !attempt.stop.geofenceEnabledSnapshot
    || attempt.stop.deliveredAt
    || attempt.stop.cancelledAt
    || attempt.stop.assignmentMode !== 'IN_HOUSE'
    || !attempt.stop.routeDay
    || attempt.stop.routeDay.courierId !== actor.id
    || !attempt.stop.routeDay.startedAt
    || !isSameMskDate(attempt.stop.deliveryDate, now)
  ) {
    throw new DeliveryOverrideAccessError()
  }
}

export async function createDeliveryOverrideRequestInTransaction(
  txValue: unknown,
  actor: RouteStopCompletionActor,
  input: {
    stopId: string
    geoAttemptId: string
    comment: string
    now: Date
  },
): Promise<DeliveryOverrideRequestResult> {
  const comment = input.comment.trim()
  if (!comment || comment.length > 1_000) throw new DeliveryOverrideCommentError()
  const tx = txValue as OverrideTransaction
  const attempt = await tx.deliveryGeoAttempt.findUnique({
    where: { id: input.geoAttemptId },
    select: {
      id: true,
      stopId: true,
      courierId: true,
      result: true,
      distanceM: true,
      overrideRequest: { select: { id: true, status: true, expiresAt: true } },
      stop: {
        select: {
          id: true,
          deliveryDate: true,
          version: true,
          assignmentMode: true,
          deliveredAt: true,
          completionMethod: true,
          cancelledAt: true,
          geofenceEnabledSnapshot: true,
          routeDay: {
            select: {
              id: true,
              courierId: true,
              courierNameSnapshot: true,
              startedAt: true,
              completedAt: true,
            },
          },
          orders: { select: { id: true, status: true } },
        },
      },
    },
  })
  assertOwnFailedAttempt(attempt, actor, input.stopId, input.now)

  const existing = await tx.deliveryOverrideRequest.findFirst({
    where: { stopId: input.stopId, status: 'PENDING' },
    select: { id: true, stopId: true, status: true, expiresAt: true },
  })
  if (existing && existing.expiresAt.getTime() > input.now.getTime()) {
    return {
      requestId: existing.id,
      stopId: existing.stopId,
      status: 'PENDING',
      expiresAt: existing.expiresAt,
      created: false,
    }
  }
  if (existing) {
    const expired = await tx.deliveryOverrideRequest.updateMany({
      where: { id: existing.id, status: 'PENDING', expiresAt: { lte: input.now } },
      data: { status: 'EXPIRED', resolvedAt: input.now },
    })
    if (expired.count !== 1) throw new RouteStopVersionError()
  }
  if (attempt.overrideRequest) throw new DeliveryOverrideAccessError()

  const expiresAt = new Date(input.now.getTime() + OVERRIDE_TTL_MS)
  const created = await tx.deliveryOverrideRequest.create({
    data: {
      stopId: input.stopId,
      geoAttemptId: input.geoAttemptId,
      courierId: actor.id,
      courierNameSnapshot: actor.name,
      comment,
      status: 'PENDING',
      expiresAt,
    },
    select: { id: true, stopId: true, status: true, expiresAt: true },
  })
  await tx.activityLog.create({
    data: {
      userId: actor.id,
      userRole: actor.role,
      action: 'DELIVERY_OVERRIDE_REQUESTED',
      entityType: 'DeliveryOverrideRequest',
      entityId: created.id,
      payload: {
        stopId: input.stopId,
        geoAttemptId: input.geoAttemptId,
        geoResult: attempt.result,
        distanceM: attempt.distanceM === null
          ? null
          : typeof attempt.distanceM === 'number'
            ? attempt.distanceM
            : attempt.distanceM.toNumber(),
        expiresAt: created.expiresAt.toISOString(),
      },
    },
  })

  return {
    requestId: created.id,
    stopId: created.stopId,
    status: 'PENDING',
    expiresAt: created.expiresAt,
    created: true,
  }
}

function terminalOverrideResult(request: OverrideRequestRow): ResolveDeliveryOverrideResult {
  return {
    requestId: request.id,
    status: request.status,
    stopDelivered: request.status === 'APPROVED' || Boolean(request.stop.deliveredAt),
    idempotent: true,
  }
}

export async function resolveDeliveryOverrideRequestInTransaction(
  txValue: unknown,
  actor: RouteStopCompletionActor,
  input: ResolveDeliveryOverrideInput,
): Promise<ResolveDeliveryOverrideResult> {
  if (!isManager(actor)) throw new DeliveryOverrideAccessError()
  const tx = txValue as OverrideTransaction
  const request = await tx.deliveryOverrideRequest.findUnique({
    where: { id: input.requestId },
    select: {
      id: true,
      stopId: true,
      geoAttemptId: true,
      courierId: true,
      courierNameSnapshot: true,
      comment: true,
      status: true,
      expiresAt: true,
      resolvedAt: true,
      resolvedById: true,
      resolutionComment: true,
      geoAttempt: {
        select: {
          id: true,
          stopId: true,
          courierId: true,
          result: true,
          distanceM: true,
        },
      },
      stop: {
        select: {
          id: true,
          deliveryDate: true,
          version: true,
          assignmentMode: true,
          deliveredAt: true,
          completionMethod: true,
          cancelledAt: true,
          geofenceEnabledSnapshot: true,
          routeDay: {
            select: {
              id: true,
              courierId: true,
              courierNameSnapshot: true,
              startedAt: true,
              completedAt: true,
            },
          },
          orders: { select: { id: true, status: true } },
        },
      },
    },
  })
  if (!request) throw new DeliveryOverrideAccessError()
  if (request.status !== 'PENDING') return terminalOverrideResult(request)

  if (request.expiresAt.getTime() <= input.now.getTime()) {
    const expired = await tx.deliveryOverrideRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: { status: 'EXPIRED', resolvedAt: input.now },
    })
    if (expired.count !== 1) throw new RouteStopVersionError()
    return {
      requestId: request.id,
      status: 'EXPIRED',
      stopDelivered: false,
      idempotent: false,
    }
  }

  const resolutionComment = input.comment?.trim() || null
  if (input.decision === 'REJECT') {
    const rejected = await tx.deliveryOverrideRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        resolvedById: actor.id,
        resolvedByNameSnapshot: actor.name,
        resolvedAt: input.now,
        resolutionComment,
      },
    })
    if (rejected.count !== 1) throw new RouteStopVersionError()
    await tx.activityLog.create({
      data: {
        userId: actor.id,
        userRole: actor.role,
        action: 'DELIVERY_OVERRIDE_REJECTED',
        entityType: 'DeliveryOverrideRequest',
        entityId: request.id,
        payload: { stopId: request.stopId, resolutionComment },
      },
    })
    return {
      requestId: request.id,
      status: 'REJECTED',
      stopDelivered: false,
      idempotent: false,
    }
  }

  if (request.stop.cancelledAt) throw new RouteStopCancelledError()
  if (
    !request.stop.deliveredAt
    && (
      request.stop.assignmentMode !== 'IN_HOUSE'
      || !request.stop.routeDay
      || request.stop.routeDay.courierId !== request.courierId
      || !request.stop.routeDay.startedAt
    )
  ) {
    throw new DeliveryOverrideAccessError(
      'Назначение остановки изменилось. Курьеру нужно отправить новый запрос.',
    )
  }
  const approved = await tx.deliveryOverrideRequest.updateMany({
    where: { id: request.id, status: 'PENDING' },
    data: {
      status: 'APPROVED',
      resolvedById: actor.id,
      resolvedByNameSnapshot: actor.name,
      resolvedAt: input.now,
      resolutionComment,
    },
  })
  if (approved.count !== 1) throw new RouteStopVersionError()

  if (!request.stop.deliveredAt) {
    const orderIds = activeOrderIds(request.stop)
    if (orderIds.length === 0) throw new RouteStopNoActiveOrdersError()
    await finalizeRouteStopDeliveryInTransaction(tx, {
      stopId: request.stop.id,
      currentVersion: request.stop.version,
      expectedVersion: request.stop.version,
      routeDayId: request.stop.routeDay?.id ?? null,
      activeOrderIds: orderIds,
      actor,
      now: input.now,
      completionMethod: 'MANAGER_OVERRIDE',
      legacyDeliveryType: 'IN_HOUSE',
      courierName: request.courierNameSnapshot,
      activityAction: 'DELIVERY_OVERRIDE_APPROVED',
      activityPayload: {
        overrideRequestId: request.id,
        requestingCourierId: request.courierId,
        geoAttemptId: request.geoAttemptId,
        geoResult: request.geoAttempt.result,
        courierComment: request.comment,
        resolutionComment,
      },
    })
  }

  return {
    requestId: request.id,
    status: 'APPROVED',
    stopDelivered: true,
    idempotent: false,
  }
}

export async function completeRouteStopAsManagerInTransaction(
  txValue: unknown,
  actor: RouteStopCompletionActor,
  input: {
    stopId: string
    expectedVersion: number
    reason: string | null
    now: Date
  },
): Promise<{
  stopId: string
  delivered: true
  idempotent: boolean
  version: number
  completionMethod: CourierStopCompletionMethod
}> {
  if (!isManager(actor)) throw new DeliveryOverrideAccessError()
  const tx = txValue as OverrideTransaction
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
      routeDay: {
        select: {
          id: true,
          courierId: true,
          courierNameSnapshot: true,
          startedAt: true,
          completedAt: true,
        },
      },
      orders: {
        where: { status: { in: [...ACTIVE_ROUTE_ORDER_STATUSES, 'DELIVERED'] } },
        select: { id: true, status: true },
      },
    },
  })
  if (!stop) throw new DeliveryOverrideAccessError()
  if (stop.cancelledAt) throw new RouteStopCancelledError()
  if (stop.deliveredAt) {
    return {
      stopId: stop.id,
      delivered: true,
      idempotent: true,
      version: stop.version,
      completionMethod: stop.completionMethod ?? 'MANAGER_DIRECT',
    }
  }
  if (stop.version !== input.expectedVersion) throw new RouteStopVersionError()

  const reason = input.reason?.trim() || null
  if (stop.assignmentMode !== 'EXTERNAL' && !reason) {
    throw new DeliveryOverrideCommentError('Для внутренней доставки укажите причину.')
  }
  const orderIds = activeOrderIds(stop)
  if (orderIds.length === 0) throw new RouteStopNoActiveOrdersError()

  const version = await finalizeRouteStopDeliveryInTransaction(tx, {
    stopId: stop.id,
    currentVersion: stop.version,
    expectedVersion: input.expectedVersion,
    routeDayId: stop.routeDay?.id ?? null,
    activeOrderIds: orderIds,
    actor,
    now: input.now,
    completionMethod: 'MANAGER_DIRECT',
    legacyDeliveryType: stop.assignmentMode === 'EXTERNAL'
      ? 'EXTERNAL_COURIER'
      : 'IN_HOUSE',
    courierName: stop.assignmentMode === 'EXTERNAL'
      ? 'InDrive'
      : stop.routeDay?.courierNameSnapshot ?? actor.name,
    activityAction: 'MANAGER_ROUTE_STOP_DELIVERED_DIRECT',
    activityPayload: { assignmentMode: stop.assignmentMode, reason },
  })

  return {
    stopId: stop.id,
    delivered: true,
    idempotent: false,
    version,
    completionMethod: 'MANAGER_DIRECT',
  }
}

const TRANSACTION_OPTIONS = {
  isolationLevel: 'Serializable' as const,
  maxWait: 5_000,
  timeout: 10_000,
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'P2002'
}

export async function createDeliveryOverrideRequestCore(
  actor: RouteStopCompletionActor,
  input: Parameters<typeof createDeliveryOverrideRequestInTransaction>[2],
): Promise<DeliveryOverrideRequestResult> {
  const { prismaDirect } = await import('@/lib/db/prisma-direct')
  const run = () => runWithPrismaConflictRetry(() =>
    prismaDirect.$transaction(
      (tx) => createDeliveryOverrideRequestInTransaction(tx, actor, input),
      TRANSACTION_OPTIONS,
    ),
  )
  try {
    return await run()
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    return run()
  }
}

export async function resolveDeliveryOverrideRequestCore(
  actor: RouteStopCompletionActor,
  input: ResolveDeliveryOverrideInput,
): Promise<ResolveDeliveryOverrideResult> {
  const { prismaDirect } = await import('@/lib/db/prisma-direct')
  return runWithPrismaConflictRetry(() =>
    prismaDirect.$transaction(
      (tx) => resolveDeliveryOverrideRequestInTransaction(tx, actor, input),
      TRANSACTION_OPTIONS,
    ),
  )
}

export async function completeRouteStopAsManagerCore(
  actor: RouteStopCompletionActor,
  input: Parameters<typeof completeRouteStopAsManagerInTransaction>[2],
) {
  const { prismaDirect } = await import('@/lib/db/prisma-direct')
  return runWithPrismaConflictRetry(() =>
    prismaDirect.$transaction(
      (tx) => completeRouteStopAsManagerInTransaction(tx, actor, input),
      TRANSACTION_OPTIONS,
    ),
  )
}
