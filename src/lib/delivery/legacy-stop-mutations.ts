import type { Prisma } from '@prisma/client'
import { parseWindowToDate } from '@/lib/utils/msk-window'
import {
  DeliveryStopAccessError,
  assertLegacyStopExpectedVersions,
  loadLegacyPhysicalStop,
  type DeliveryActor,
  type LegacyStopOrder,
} from './legacy-stop'

export class DeliveryUndoTtlError extends Error {
  constructor() {
    super('Откатить можно только в течение часа после доставки')
    this.name = 'DeliveryUndoTtlError'
  }
}

export class DeliveryWindowNotStartedError extends Error {
  constructor(windowFrom: string) {
    super(`Окно доставки ещё не началось (с ${windowFrom})`)
    this.name = 'DeliveryWindowNotStartedError'
  }
}

interface MutationBase {
  actor: DeliveryActor
  orderIds: readonly string[]
  now: Date
}

export async function markLegacyStopDeliveredInTransaction(
  tx: Prisma.TransactionClient,
  input: MutationBase & {
    expectedUpdatedAts: Readonly<Record<string, string>> | undefined
  },
): Promise<{ updated: number; orderIds: string[]; orders: LegacyStopOrder[] }> {
  const stop = await loadLegacyPhysicalStop(tx, input.orderIds, input.actor)
  // Once materialized, every completion path must go through Delivery 2.0
  // geofence/version/ownership rules. This closes the read→materialize race in
  // the legacy server action as well as direct calls to this transaction core.
  if (stop.orders.some((order) => order.routeStopId)) {
    throw new DeliveryStopAccessError()
  }
  const toDeliver = assertLegacyStopExpectedVersions(stop.orders, input.expectedUpdatedAts)

  // A repeated request still performs the complete stop/ownership read above,
  // but has no writes or side effects.
  if (toDeliver.length === 0) return { ...stop, updated: 0 }

  if (input.actor.role === 'COURIER') {
    for (const order of toDeliver) {
      const windowStart = parseWindowToDate(
        order.location.deliveryWindowFrom,
        order.deliveryDate,
      )
      if (windowStart && input.now < windowStart) {
        throw new DeliveryWindowNotStartedError(order.location.deliveryWindowFrom!)
      }
    }
  }

  for (const order of toDeliver) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'DELIVERED' },
    })

    if (order.delivery) {
      await tx.delivery.update({
        where: { id: order.delivery.id },
        data: {
          status: 'DELIVERED',
          deliveredAt: input.now,
          ...(order.delivery.courierName ? {} : { courierName: input.actor.name }),
        },
      })
    } else {
      await tx.delivery.create({
        data: {
          orderId: order.id,
          type: 'IN_HOUSE',
          status: 'DELIVERED',
          deliveredAt: input.now,
          courierName: input.actor.name,
        },
      })
    }
  }

  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: 'STOP_DELIVERED',
      entityType: 'OrderBatch',
      entityId: stop.orderIds[0],
      payload: {
        orderIds: stop.orderIds,
        count: toDeliver.length,
        courierName: input.actor.name,
      },
    },
  })

  return { ...stop, updated: toDeliver.length }
}

export async function reportLegacyStopIssueInTransaction(
  tx: Prisma.TransactionClient,
  input: MutationBase & { reason: string; comment: string | null },
): Promise<{ updated: number; orderIds: string[]; orders: LegacyStopOrder[] }> {
  const stop = await loadLegacyPhysicalStop(tx, input.orderIds, input.actor)

  for (const order of stop.orders) {
    const issueData = {
      issueReportedAt: input.now,
      issueReason: input.reason,
      issueComment: input.comment,
      issueReportedById: input.actor.id,
    }
    if (order.delivery) {
      await tx.delivery.update({
        where: { id: order.delivery.id },
        data: issueData,
      })
    } else {
      await tx.delivery.create({
        data: {
          orderId: order.id,
          type: 'IN_HOUSE',
          status: 'ASSIGNED',
          ...issueData,
        },
      })
    }
  }

  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: 'COURIER_REPORTED_DELIVERY_ISSUE',
      entityType: 'OrderBatch',
      entityId: stop.orderIds[0],
      payload: {
        orderIds: stop.orderIds,
        reason: input.reason,
        comment: input.comment,
        courierId: input.actor.id,
      },
    },
  })

  return { ...stop, updated: stop.orders.length }
}

export async function undoLegacyStopDeliveredInTransaction(
  tx: Prisma.TransactionClient,
  input: MutationBase,
): Promise<{ updated: number; orderIds: string[]; orders: LegacyStopOrder[] }> {
  if (!['ADMIN_PRO', 'ADMIN', 'MANAGER'].includes(input.actor.role)) {
    throw new DeliveryStopAccessError()
  }

  const stop = await loadLegacyPhysicalStop(tx, input.orderIds, input.actor)
  if (stop.orders.some((order) => order.routeStopId)) {
    throw new DeliveryStopAccessError()
  }
  const ttlMs = 60 * 60 * 1000
  const hasInvalidTimestamp = stop.orders.some((order) => {
    const deliveredAt = order.delivery?.deliveredAt
    if (order.status !== 'DELIVERED' || !deliveredAt) return true
    const ageMs = input.now.getTime() - deliveredAt.getTime()
    return ageMs < 0 || ageMs > ttlMs
  })
  if (hasInvalidTimestamp) throw new DeliveryUndoTtlError()

  for (const order of stop.orders) {
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'OUT_FOR_DELIVERY' },
    })
    await tx.delivery.update({
      where: { id: order.delivery!.id },
      data: { status: 'EN_ROUTE', deliveredAt: null },
    })
  }

  await tx.activityLog.create({
    data: {
      userId: input.actor.id,
      userRole: input.actor.role,
      action: 'STOP_DELIVERY_REVERTED',
      entityType: 'OrderBatch',
      entityId: stop.orderIds[0],
      payload: { orderIds: stop.orderIds, count: stop.orders.length },
    },
  })

  return { ...stop, updated: stop.orders.length }
}
