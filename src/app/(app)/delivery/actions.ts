'use server'

import { revalidatePath } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { requireRole } from '@/lib/auth/current-user'
import { notifyAllManagersDirect, escapeHtml } from '@/lib/telegram/notify'
import { orderDetailButton } from '@/lib/telegram/buttons'
import {
  DELIVERY_ISSUE_REASONS,
  DELIVERY_ISSUE_REASON_LABELS,
  type DeliveryIssueReason,
} from '@/lib/constants/delivery'
import { formatDeliveryWindow } from '@/lib/utils/format'
import { logBorisEvent, emitLivePost } from '@/lib/boris/team-channels'
import {
  DeliveryStopAccessError,
  DeliveryStopVersionError,
} from '@/lib/delivery/legacy-stop'
import {
  DeliveryUndoTtlError,
  DeliveryWindowNotStartedError,
  markLegacyStopDeliveredInTransaction,
  reportLegacyStopIssueInTransaction,
  undoLegacyStopDeliveredInTransaction,
} from '@/lib/delivery/legacy-stop-mutations'
import { runWithPrismaConflictRetry } from '@/lib/delivery/prisma-transaction-retry'
import {
  RouteStopAccessError,
  RouteStopCancelledError,
  RouteStopDateError,
  RouteStopNoActiveOrdersError,
  RouteStopNotStartedError,
  RouteStopVersionError,
  completeRouteStopCore,
} from '@/lib/delivery/route-completion'
import {
  DeliveryOverrideAccessError,
  DeliveryOverrideCommentError,
  completeRouteStopAsManagerCore,
} from '@/lib/delivery/delivery-override'

const markDeliveredSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, 'Список заказов пуст'),
  // API remains optional for an idempotent retry of an already-delivered stop.
  // The transaction core requires an exact value for every active order.
  expectedUpdatedAts: z.record(z.string(), z.string()).optional(),
})

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const DELIVERY_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 10_000,
  isolationLevel: 'Serializable' as const,
}

function expectedDeliveryError(error: unknown): string | null {
  if (
    error instanceof DeliveryStopAccessError ||
    error instanceof DeliveryStopVersionError ||
    error instanceof DeliveryWindowNotStartedError ||
    error instanceof DeliveryUndoTtlError ||
    error instanceof RouteStopAccessError ||
    error instanceof RouteStopCancelledError ||
    error instanceof RouteStopDateError ||
    error instanceof RouteStopNoActiveOrdersError ||
    error instanceof RouteStopNotStartedError ||
    error instanceof RouteStopVersionError ||
    error instanceof DeliveryOverrideAccessError ||
    error instanceof DeliveryOverrideCommentError
  ) {
    return error.message
  }
  return null
}

export async function markStopDelivered(
  formData: z.infer<typeof markDeliveredSchema>
): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const parsed = markDeliveredSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderIds, expectedUpdatedAts } = parsed.data
  let mutation
  try {
    const normalizedOrderIds = [...new Set(orderIds)]
    const linkedOrders = await prisma.order.findMany({
      where: { id: { in: normalizedOrderIds } },
      select: {
        id: true,
        routeStopId: true,
        routeStop: {
          select: { id: true, version: true, assignmentMode: true },
        },
      },
    })
    const linkedStopIds = new Set(
      linkedOrders
        .map((order) => order.routeStopId)
        .filter((id): id is string => id !== null),
    )

    if (linkedStopIds.size > 0) {
      const routeStop = linkedOrders[0]?.routeStop
      if (
        linkedOrders.length !== normalizedOrderIds.length
        || linkedStopIds.size !== 1
        || linkedOrders.some((order) => order.routeStopId !== routeStop?.id)
        || !routeStop
      ) {
        throw new DeliveryStopAccessError()
      }

      const now = new Date()
      const completed = user.role === 'COURIER'
        ? await completeRouteStopCore(user, {
            stopId: routeStop.id,
            expectedVersion: routeStop.version,
            requestId: `legacy:${routeStop.id}:${routeStop.version}`,
            position: null,
            now,
          })
        : await completeRouteStopAsManagerCore(user, {
            stopId: routeStop.id,
            expectedVersion: routeStop.version,
            reason: null,
            now,
          })

      if (!completed.delivered) {
        return {
          ok: false,
          error:
            'Для этой точки требуется проверка геопозиции. ' +
            'Откройте точку маршрута и подтвердите доставку там.',
        }
      }

      const deliveredOrders = await prisma.order.findMany({
        where: { routeStopId: routeStop.id, status: 'DELIVERED' },
        select: { id: true },
      })
      mutation = {
        updated: completed.idempotent ? 0 : deliveredOrders.length,
        orderIds: deliveredOrders.map((order) => order.id),
        orders: [],
      }
    } else {
      mutation = await runWithPrismaConflictRetry(() =>
        prismaDirect.$transaction(
          (tx) =>
            markLegacyStopDeliveredInTransaction(tx, {
              actor: user,
              orderIds,
              expectedUpdatedAts,
              now: new Date(),
            }),
          DELIVERY_TRANSACTION_OPTIONS,
        ),
      )
    }
  } catch (error) {
    const message = expectedDeliveryError(error)
    if (message) return { ok: false, error: message }
    throw error
  }

  // Reconcile caches and the deduplicated Boris event even after an idempotent
  // replay. The transaction core has already avoided duplicate writes/audit.
  revalidatePath('/delivery')
  revalidatePath('/orders')

  // 7.16.C: триггер Командного Бориса — первая доставка клиенту.
  // 7.16.C.2: logBorisEvent синхронно (быстрые БД-запросы), emit через waitUntil.
  // Логика:
  //   1. Берём заказы, которые только что попали в DELIVERED.
  //   2. Для каждого уникального клиента считаем общее число DELIVERED.
  //   3. Если deliveredCount === 1 → это была первая доставка → эмит.
  //   4. Дедуп: `first_delivery:${clientId}` гарантирует один эмит на клиента,
  //      даже если race-condition попытается записать дважды (logBorisEvent
  //      внутри ловит P2002 и возвращает null).
  try {
    const ordersWithClient = await prisma.order.findMany({
      where: { id: { in: mutation.orderIds }, status: 'DELIVERED' },
      select: {
        id: true,
        clientId: true,
        portions: true,
        mealType: true,
        client: { select: { name: true } },
        location: { select: { name: true } },
      },
    })
    const seenClients = new Set<string>()
    for (const o of ordersWithClient) {
      if (seenClients.has(o.clientId)) continue
      seenClients.add(o.clientId)
      const deliveredCount = await prisma.order.count({
        where: { clientId: o.clientId, status: 'DELIVERED' },
      })
      if (deliveredCount !== 1) continue
      const event = await logBorisEvent({
        eventType: 'FIRST_DELIVERY',
        eventDate: new Date(),
        clientId: o.clientId,
        orderId: o.id,
        payload: {
          clientName: o.client.name,
          portions: o.portions,
          locationName: o.location.name,
          mealType: o.mealType,
        },
        deduplKey: `first_delivery:${o.clientId}`,
      })
      if (event) {
        waitUntil(
          emitLivePost(event).catch((err) =>
            console.error('[boris-team] first_delivery emit failed', err),
          ),
        )
      }
    }
  } catch (err) {
    console.error('[boris-team] first_delivery trigger failed', err)
  }

  return { ok: true, data: { updated: mutation.updated } }
}

const reportIssueSchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, 'Список заказов пуст'),
  reason: z.enum(DELIVERY_ISSUE_REASONS),
  comment: z.string().trim().max(200).optional().nullable(),
})

/**
 * Курьер сообщает «не смог доставить» по остановке (или менеджер от его имени).
 * Статус Order НЕ меняется — менеджер сам решает (звонок, перенос, отмена).
 * Запись идёт во все Delivery остановки (одна остановка = N order'ов).
 * Push в личку всем активным MANAGER. Если push упал — save не блокируется.
 */
export async function reportDeliveryIssue(
  formData: z.infer<typeof reportIssueSchema>
): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const parsed = reportIssueSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderIds, reason, comment } = parsed.data
  const normalizedComment = comment?.trim() || null
  let mutation
  try {
    mutation = await runWithPrismaConflictRetry(() =>
      prismaDirect.$transaction(
        (tx) =>
          reportLegacyStopIssueInTransaction(tx, {
            actor: user,
            orderIds,
            reason,
            comment: normalizedComment,
            now: new Date(),
          }),
        DELIVERY_TRANSACTION_OPTIONS,
      ),
    )
  } catch (error) {
    const message = expectedDeliveryError(error)
    if (message) return { ok: false, error: message }
    throw error
  }

  // Push в личку всем MANAGER+ADMIN c Telegram. Метаданные берём с первого
  // заказа остановки — все принадлежат одной location и client.
  const first = mutation.orders[0]
  const windowStr = formatDeliveryWindow(first.location.deliveryWindowFrom, first.location.deliveryWindowTo)
  const lines: string[] = [
    `🚨 <b>Проблема с доставкой</b>`,
    ``,
    `${escapeHtml(first.client.name)} · ${escapeHtml(first.location.name)}`,
  ]
  if (windowStr !== '—') lines.push(`Окно: ${windowStr}`)
  lines.push(``)
  lines.push(`Причина: ${DELIVERY_ISSUE_REASON_LABELS[reason as DeliveryIssueReason]}`)
  if (normalizedComment) lines.push(`Курьер: «${escapeHtml(normalizedComment)}»`)
  lines.push(``)
  lines.push(`Сообщил: ${escapeHtml(user.name)}`)

  try {
    await notifyAllManagersDirect(lines.join('\n'), {
      parseMode: 'HTML',
      replyMarkup: orderDetailButton(first.id),
    })
  } catch (error) {
    console.error(
      '[delivery] issue notification failed after commit:',
      error instanceof Error ? error.message : 'unknown error',
    )
  }

  revalidatePath('/delivery')
  revalidatePath('/orders')
  revalidatePath(`/orders/${first.id}`)
  return { ok: true, data: { updated: mutation.updated } }
}

const clearIssueSchema = z.object({
  deliveryId: z.string().min(1),
})

/**
 * Менеджер снимает метку «проблема» с одной Delivery. Используется на
 * /orders/[id] — после звонка клиенту, переноса или ручного разруливания.
 * Не удаляет ActivityLog (исторический след сохраняется).
 */
export async function clearDeliveryIssue(
  formData: z.infer<typeof clearIssueSchema>
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = clearIssueSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id: parsed.data.deliveryId },
    select: { id: true, orderId: true, issueReportedAt: true, issueReason: true },
  })
  if (!delivery) return { ok: false, error: 'Доставка не найдена' }
  if (!delivery.issueReportedAt) return { ok: false, error: 'Метка уже снята' }

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      issueReportedAt: null,
      issueReason: null,
      issueComment: null,
      issueReportedById: null,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MANAGER_CLEARED_DELIVERY_ISSUE',
      entityType: 'Order',
      entityId: delivery.orderId,
      payload: { deliveryId: delivery.id, clearedReason: delivery.issueReason },
    },
  })

  revalidatePath('/delivery')
  revalidatePath('/orders')
  revalidatePath(`/orders/${delivery.orderId}`)
  return { ok: true, data: undefined }
}

export async function undoStopDelivered(orderIds: string[]): Promise<ActionResult<{ updated: number }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return { ok: false, error: 'Список заказов пуст' }
  }

  let mutation
  try {
    mutation = await runWithPrismaConflictRetry(() =>
      prismaDirect.$transaction(
        (tx) =>
          undoLegacyStopDeliveredInTransaction(tx, {
            actor: user,
            orderIds,
            now: new Date(),
          }),
        DELIVERY_TRANSACTION_OPTIONS,
      ),
    )
  } catch (error) {
    const message = expectedDeliveryError(error)
    if (message) return { ok: false, error: message }
    throw error
  }

  revalidatePath('/delivery')
  return { ok: true, data: { updated: mutation.updated } }
}
