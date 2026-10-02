import type { MealType, OrderSource, OrderStatus, UserRole } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  cancelOrderCore,
  createOneTimeOrderCore,
  editOrderPortionsCore,
} from '@/app/(app)/orders/actions'
import { CUTOFF_HOUR_MSK, getCutoffMoment } from '@/lib/orders/cutoff'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

/**
 * Применение числа клиента к заказам (бот, недельная заявка, STICKY, старые
 * кнопки аномалий). Один путь для «на дату/точку/тип уже есть заказ → обновить,
 * нет → создать, 0 → отменить», всё через Core-функции заказов.
 *
 * Модуль НЕ 'use server' — вызывается из webhook/callback-контекстов, где нет
 * сессии и requireRole невозможен. Права проверяют сами Core-функции по actor.
 */

export interface Actor {
  id: string
  role: UserRole
}

/** Заказ уже в работе у кухни/курьера — число клиента сюда автоматически не пишем. */
export const IN_WORK_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
])

export type PortionsChangeKind = 'created' | 'updated' | 'confirmed' | 'cancelled' | 'unchanged' | 'noop'

export type PortionsChangeResult =
  | {
      ok: true
      kind: PortionsChangeKind
      orderId: string | null
      prevPortions: number | null
      prevStatus: OrderStatus | null
    }
  | { ok: false; skipped: true; reason: string; orderId: string | null }
  | { ok: false; skipped: false; error: string; orderId: string | null }

/**
 * Системный исполнитель для автоматических действий без живого пользователя
 * (webhook MAX). Core-функции пишут userId в ActivityLog/createdById — берём
 * старейшего активного ADMIN_PRO; в собственных логах помечаем `auto: true`.
 */
export async function resolveSystemActor(): Promise<Actor | null> {
  const user = await prisma.user.findFirst({
    where: { role: 'ADMIN_PRO', isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true },
  })
  return user
}

/**
 * PENDING_CONFIRMATION/DRAFT → CONFIRMED с числом клиента. Аналог
 * confirmDynamicOrder без requireRole (тот — server action для UI).
 */
export async function confirmPendingOrderCore(
  actor: Actor,
  input: { orderId: string; portions: number; via: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!['ADMIN', 'ADMIN_PRO', 'MANAGER'].includes(actor.role)) {
    return { ok: false, error: 'Нет прав' }
  }
  if (!Number.isInteger(input.portions) || input.portions <= 0) {
    return { ok: false, error: 'Порций должно быть больше нуля' }
  }
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, status: true, portions: true, pricePerPortion: true },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status !== 'PENDING_CONFIRMATION' && order.status !== 'DRAFT') {
    return { ok: false, error: `Заказ в статусе ${order.status}, подтверждение невозможно` }
  }

  const totalPrice = order.pricePerPortion.mul(input.portions)
  await prisma.order.update({
    where: { id: order.id },
    data: {
      portions: input.portions,
      totalPrice,
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
  })
  await prisma.activityLog.create({
    data: {
      userId: actor.id,
      userRole: actor.role,
      action: 'ORDER_CONFIRMED',
      entityType: 'Order',
      entityId: order.id,
      payload: {
        previousStatus: order.status,
        oldPortions: order.portions,
        portions: input.portions,
        totalPrice: Number(totalPrice),
        via: input.via,
      },
    },
  })
  return { ok: true }
}

/**
 * Ставит заказу число клиента с учётом статуса и УПД:
 *  - есть УПД / заказ в работе → пропуск с причиной (не ошибка);
 *  - 0 → отмена через cancelOrderCore;
 *  - PENDING/DRAFT → CONFIRMED с числом;
 *  - CONFIRMED → editOrderPortionsCore (то же число → unchanged).
 */
export async function setOrderPortionsForClient(
  actor: Actor,
  input: { orderId: string; portions: number; via: string },
): Promise<PortionsChangeResult> {
  const { orderId, portions, via } = input
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, portions: true, updDocumentLink: { select: { id: true } } },
  })
  if (!order) return { ok: false, skipped: false, error: 'Заказ не найден', orderId }
  if (order.updDocumentLink) {
    return { ok: false, skipped: true, reason: 'по заказу уже выписан УПД', orderId }
  }
  if (order.status === 'CANCELLED') {
    return { ok: false, skipped: false, error: 'заказ отменён', orderId }
  }
  if (IN_WORK_STATUSES.has(order.status)) {
    return { ok: false, skipped: true, reason: `заказ уже в работе (${order.status})`, orderId }
  }

  const prev = { orderId, prevPortions: order.portions, prevStatus: order.status }

  if (portions === 0) {
    const r = await cancelOrderCore(actor, { orderId, reason: via })
    if (!r.ok) return { ok: false, skipped: false, error: r.error, orderId }
    return { ok: true, kind: 'cancelled', ...prev }
  }

  if (order.status === 'PENDING_CONFIRMATION' || order.status === 'DRAFT') {
    const r = await confirmPendingOrderCore(actor, { orderId, portions, via })
    if (!r.ok) return { ok: false, skipped: false, error: r.error, orderId }
    return { ok: true, kind: 'confirmed', ...prev }
  }

  if (order.portions === portions) return { ok: true, kind: 'unchanged', ...prev }

  const r = await editOrderPortionsCore(actor, { orderId, portions })
  if (!r.ok) return { ok: false, skipped: false, error: r.error, orderId }
  return { ok: true, kind: 'updated', ...prev }
}

/**
 * Число клиента на бизнес-ключ {клиент, точка, тип питания, дата}: есть живой
 * заказ → setOrderPortionsForClient; нет → createOneTimeOrderCore (цена из
 * конфига); 0 без заказа → noop. deliveryDate — UTC-полночь МСК-дня (@db.Date).
 */
export async function applyPortionsByBusinessKey(
  actor: Actor,
  input: {
    clientId: string
    locationId: string
    mealType: MealType
    deliveryDate: Date
    portions: number
    source: OrderSource
    via: string
    weeklySubmissionId?: string
    /** Для созданного заказа: конфиг-источник и пометки клиента (кухня видит на заказе). */
    sourceConfigId?: string
    notes?: string | null
  },
): Promise<PortionsChangeResult> {
  const existing = await prisma.order.findFirst({
    where: {
      clientId: input.clientId,
      locationId: input.locationId,
      mealType: input.mealType,
      deliveryDate: input.deliveryDate,
      status: { not: 'CANCELLED' },
    },
    select: { id: true },
  })
  if (existing) {
    return setOrderPortionsForClient(actor, {
      orderId: existing.id,
      portions: input.portions,
      via: input.via,
    })
  }
  if (input.portions === 0) {
    return { ok: true, kind: 'noop', orderId: null, prevPortions: null, prevStatus: null }
  }

  const created = await createOneTimeOrderCore(actor, {
    clientId: input.clientId,
    locationId: input.locationId,
    mealType: input.mealType,
    deliveryDate: input.deliveryDate,
    portions: input.portions,
    source: input.source,
    silent: true,
  })
  if (!created.ok) return { ok: false, skipped: false, error: created.error, orderId: null }

  if (input.weeklySubmissionId || input.sourceConfigId || input.notes) {
    await prisma.order.update({
      where: { id: created.data.orderId },
      data: {
        ...(input.weeklySubmissionId ? { weeklySubmissionId: input.weeklySubmissionId } : {}),
        ...(input.sourceConfigId ? { sourceConfigId: input.sourceConfigId } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      },
    })
  }
  return { ok: true, kind: 'created', orderId: created.data.orderId, prevPortions: null, prevStatus: null }
}

export interface LocationForEditability {
  sameDayDelivery: boolean
  isActive?: boolean
  cutoffHourMsk: number | null
  cutoffMinuteMsk: number | null
}

/**
 * Можно ли ещё менять доставку на эту дату (cut-off per-location):
 * same-day точка — до её cut-off в сам день доставки, обычная — до 16:00 МСК
 * накануне. Прошедшие МСК-дни — никогда.
 */
export function isDeliveryDateEditable(
  location: LocationForEditability,
  deliveryDate: Date,
  now: Date = new Date(),
): boolean {
  if (deliveryDate.getTime() < getMskCalendarDayUtc(now, 0).getTime()) return false
  const sameDay = location.sameDayDelivery && location.isActive !== false
  const moment = sameDay
    ? getCutoffMoment(
        deliveryDate,
        location.cutoffHourMsk ?? CUTOFF_HOUR_MSK,
        location.cutoffMinuteMsk ?? 0,
        true,
      )
    : getCutoffMoment(deliveryDate, CUTOFF_HOUR_MSK, 0, false)
  return now.getTime() < moment.getTime()
}

/** Ближайший МСК-день доставки, который ещё можно менять (сегодня/завтра/послезавтра). */
export function firstEditableDeliveryDate(
  location: LocationForEditability,
  now: Date = new Date(),
): Date {
  for (let offset = 0; offset < 3; offset++) {
    const day = getMskCalendarDayUtc(now, offset)
    if (isDeliveryDateEditable(location, day, now)) return day
  }
  return getMskCalendarDayUtc(now, 2)
}
