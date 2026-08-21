'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { ensureCourierRouteStopsForDate } from '@/lib/delivery/route-materializer'
import { runWithPrismaConflictRetry } from '@/lib/delivery/prisma-transaction-retry'
import {
  CourierRouteAccessError,
  CourierRouteCancelledStopError,
  CourierRouteDeliveredStopError,
  CourierRouteNotFoundError,
  CourierRouteVersionError,
  assignCourierRouteStopInTransaction,
  startOwnCourierRouteInTransaction,
} from '@/lib/delivery/route-mutations'
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
  createDeliveryOverrideRequestCore,
  resolveDeliveryOverrideRequestCore,
} from '@/lib/delivery/delivery-override'
import { deliveryOverrideButtons } from '@/lib/telegram/buttons'
import { escapeHtml, notifyAllManagersDirect } from '@/lib/telegram/notify'

export type RouteActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

const ROUTE_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 10_000,
  isolationLevel: 'Serializable' as const,
}

const assignmentSchema = z.object({
  stopId: z.string().min(1, 'Остановка не указана.'),
  expectedVersion: z.number().int().positive('Версия остановки некорректна.'),
  assignmentMode: z.enum(['IN_HOUSE', 'EXTERNAL', 'UNASSIGNED']),
  courierId: z.string().min(1).nullable(),
}).superRefine((value, context) => {
  if (value.assignmentMode === 'IN_HOUSE' && !value.courierId) {
    context.addIssue({
      code: 'custom',
      path: ['courierId'],
      message: 'Выберите курьера.',
    })
  }
  if (value.assignmentMode !== 'IN_HOUSE' && value.courierId) {
    context.addIssue({
      code: 'custom',
      path: ['courierId'],
      message: 'Для этого режима курьер не указывается.',
    })
  }
})

const positionSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracyM: z.number().finite().nonnegative(),
  capturedAt: z.coerce.date(),
})

const completionSchema = z.object({
  stopId: z.string().trim().min(1, 'Остановка не указана.'),
  expectedVersion: z.number().int().positive('Версия остановки некорректна.'),
  requestId: z.string().trim().min(1, 'Запрос GPS не указан.').max(128),
  position: positionSchema.nullable(),
})

const overrideRequestSchema = z.object({
  stopId: z.string().trim().min(1, 'Остановка не указана.'),
  geoAttemptId: z.string().trim().min(1, 'Проверка GPS не указана.'),
  comment: z.string().trim().min(1, 'Добавьте обязательный комментарий.').max(1_000),
})

const managerCompletionSchema = z.object({
  stopId: z.string().trim().min(1, 'Остановка не указана.'),
  expectedVersion: z.number().int().positive('Версия остановки некорректна.'),
  reason: z.string().trim().max(1_000).nullable(),
})

const managerOverrideResolutionSchema = z.object({
  requestId: z.string().trim().min(1, 'Запрос override не указан.'),
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: z.string().trim().max(1_000).nullable(),
})

function expectedRouteError(error: unknown): string | null {
  if (
    error instanceof CourierRouteAccessError ||
    error instanceof CourierRouteCancelledStopError ||
    error instanceof CourierRouteDeliveredStopError ||
    error instanceof CourierRouteNotFoundError ||
    error instanceof CourierRouteVersionError ||
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

function firstValidationError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Неверные данные.'
}

/** Starts today's route for the authenticated courier; no courier ID is accepted. */
export async function startOwnCourierRoute(): Promise<RouteActionResult<{
  routeDayId: string
  startedAt: Date
  updated: boolean
}>> {
  const actor = await requireRole(['COURIER'])
  const now = new Date()
  const deliveryDate = getMskCalendarDayUtc(now)

  await ensureCourierRouteStopsForDate(deliveryDate, now)
  try {
    const data = await runWithPrismaConflictRetry(() =>
      prismaDirect.$transaction(
        (tx) => startOwnCourierRouteInTransaction(tx, {
          actor,
          deliveryDate,
          now,
        }),
        ROUTE_TRANSACTION_OPTIONS,
      ),
    )
    revalidatePath('/delivery')
    return { ok: true, data }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

/** Manager-only daily assignment. ClientLocation defaults are never mutated. */
export async function assignCourierRouteStop(
  input: z.input<typeof assignmentSchema>,
): Promise<RouteActionResult<{ stopId: string; version: number; updated: boolean }>> {
  const actor = await requireRole(['ADMIN', 'MANAGER'])
  const parsed = assignmentSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Неверные данные назначения.',
    }
  }

  try {
    const now = new Date()
    const data = await runWithPrismaConflictRetry(() =>
      prismaDirect.$transaction(
        (tx) => assignCourierRouteStopInTransaction(tx, {
          actor,
          ...parsed.data,
          now,
        }),
        ROUTE_TRANSACTION_OPTIONS,
      ),
    )
    revalidatePath('/delivery')
    revalidatePath('/delivery/control')
    revalidatePath('/delivery/control/analytics')
    revalidatePath('/production/print/assembly')
    return { ok: true, data }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

/** Courier completion wrapper. The authenticated actor is never client input. */
export async function completeOwnRouteStop(
  input: z.input<typeof completionSchema>,
): Promise<RouteActionResult<Awaited<ReturnType<typeof completeRouteStopCore>>>> {
  const actor = await requireRole(['COURIER'])
  const parsed = completionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  try {
    const data = await completeRouteStopCore(actor, {
      ...parsed.data,
      now: new Date(),
    })
    revalidatePath('/delivery')
    revalidatePath(`/delivery/stops/${data.stopId}`)
    revalidatePath('/orders')
    return { ok: true, data }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

function formatOverrideDistance(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'object' && 'toNumber' in value
      ? (value as { toNumber(): number }).toNumber()
      : Number(value)
  return Number.isFinite(numberValue) ? `${Math.round(numberValue)} м` : null
}

/**
 * Persists the override request first. Telegram is deliberately outside the
 * transaction, so a notification outage cannot lose the manager task in CRM.
 */
export async function requestDeliveryOverride(
  input: z.input<typeof overrideRequestSchema>,
): Promise<RouteActionResult<{
  requestId: string
  stopId: string
  status: 'PENDING'
  expiresAt: Date
  created: boolean
  notificationFailed: boolean
}>> {
  const actor = await requireRole(['COURIER'])
  const parsed = overrideRequestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  try {
    const data = await createDeliveryOverrideRequestCore(actor, {
      ...parsed.data,
      now: new Date(),
    })
    let notificationFailed = false

    if (data.created) {
      try {
        const request = await prisma.deliveryOverrideRequest.findUnique({
          where: { id: data.requestId },
          select: {
            id: true,
            comment: true,
            courierNameSnapshot: true,
            expiresAt: true,
            geoAttempt: { select: { result: true, distanceM: true } },
            stop: {
              select: {
                clientNameSnapshot: true,
                locationNameSnapshot: true,
              },
            },
          },
        })
        if (!request) {
          notificationFailed = true
        } else {
          const distance = formatOverrideDistance(request.geoAttempt.distanceM)
          const lines = [
            '🚧 <b>Нужно подтвердить доставку</b>',
            '',
            `${escapeHtml(request.stop.clientNameSnapshot)} · ${escapeHtml(request.stop.locationNameSnapshot)}`,
            `Курьер: ${escapeHtml(request.courierNameSnapshot)}`,
            `Причина: ${escapeHtml(request.comment)}`,
            `GPS: ${escapeHtml(request.geoAttempt.result)}${distance ? ` · ${distance}` : ''}`,
          ]
          const notified = await notifyAllManagersDirect(lines.join('\n'), {
            parseMode: 'HTML',
            replyMarkup: deliveryOverrideButtons(request.id),
          })
          notificationFailed = notified.sentTo === 0 || notified.failed > 0
        }
      } catch (error) {
        notificationFailed = true
        console.error('[delivery] override notification failed after commit', error)
      }
    }

    revalidatePath('/delivery')
    revalidatePath(`/delivery/stops/${data.stopId}`)
    revalidatePath('/delivery/control')
    return { ok: true, data: { ...data, notificationFailed } }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

/** Manager direct close for InDrive or a reasoned internal fallback. */
export async function completeRouteStopAsManager(
  input: z.input<typeof managerCompletionSchema>,
): Promise<RouteActionResult<Awaited<ReturnType<typeof completeRouteStopAsManagerCore>>>> {
  const actor = await requireRole(['ADMIN', 'MANAGER'])
  const parsed = managerCompletionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  try {
    const data = await completeRouteStopAsManagerCore(actor, {
      ...parsed.data,
      now: new Date(),
    })
    revalidatePath('/delivery')
    revalidatePath(`/delivery/stops/${data.stopId}`)
    revalidatePath('/delivery/control')
    revalidatePath('/delivery/control/analytics')
    revalidatePath('/orders')
    return { ok: true, data }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

/** Manager web wrapper for persisted override decisions; actor is session-only. */
export async function resolveDeliveryOverrideAsManager(
  input: z.input<typeof managerOverrideResolutionSchema>,
): Promise<RouteActionResult<Awaited<ReturnType<typeof resolveDeliveryOverrideRequestCore>>>> {
  const actor = await requireRole(['ADMIN', 'MANAGER'])
  const parsed = managerOverrideResolutionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  try {
    const data = await resolveDeliveryOverrideRequestCore(actor, {
      ...parsed.data,
      now: new Date(),
    })
    revalidatePath('/delivery')
    revalidatePath('/delivery/control')
    revalidatePath('/delivery/control/analytics')
    revalidatePath('/orders')
    revalidatePath('/production/print/assembly')
    return { ok: true, data }
  } catch (error) {
    const message = expectedRouteError(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}
