'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateFixedOrdersForDate } from '@/lib/orders/generate-orders'
import { getOrderLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import { isPastCutoff } from '@/lib/orders/cutoff'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { orderDetailButton } from '@/lib/telegram/buttons'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { formatDateShort } from '@/lib/utils/format'
import { assertOrderUpdatedAt, OptimisticLockError } from '@/lib/db/optimistic-lock'
import { MealType } from '@prisma/client'

const createOrderSchema = z.object({
  clientId: z.string().min(1, 'Выберите клиента'),
  locationId: z.string().min(1, 'Выберите точку'),
  mealType: z.enum(['BREAKFAST', 'LUNCH', 'DINNER']),
  deliveryDate: z.string().min(1, 'Укажите дату'),
  portions: z.number().int().positive('Порций должно быть больше нуля'),
  pricePerPortion: z.number().nonnegative(),
  notes: z.string().max(1000).nullable().optional(),
  configId: z.string().nullable().optional(),
})

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Создаёт ручной заказ. Менеджер заполнил форму, мы сохраняем заказ
 * со статусом CONFIRMED (ручные заказы сразу подтверждены — менеджер
 * уже договорился с клиентом устно).
 *
 * packaging берём из location, source = 'MANUAL'.
 */
export async function createOrder(
  formData: z.infer<typeof createOrderSchema>
): Promise<ActionResult<{ id: string; deliveryDate: string }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = createOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Неверные данные заказа',
    }
  }

  const data = parsed.data
  const deliveryDate = new Date(data.deliveryDate)
  deliveryDate.setHours(0, 0, 0, 0)

  // Проверяем что точка принадлежит этому клиенту, и берём её packaging
  const location = await prisma.clientLocation.findFirst({
    where: { id: data.locationId, clientId: data.clientId, isActive: true },
    select: { id: true, packaging: true },
  })

  if (!location) {
    return { ok: false, error: 'Точка не найдена или не принадлежит клиенту' }
  }

  const totalPrice = data.portions * data.pricePerPortion

  const snapshot = await getOrderLegalEntitySnapshot(data.clientId)

  const order = await prisma.order.create({
    data: {
      clientId: data.clientId,
      locationId: data.locationId,
      mealType: data.mealType,
      deliveryDate,
      portions: data.portions,
      pricePerPortion: data.pricePerPortion,
      totalPrice,
      packaging: location.packaging,
      source: 'MANUAL',
      status: 'CONFIRMED',
      notes: data.notes ?? null,
      sourceConfigId: data.configId ?? null,
      createdById: user.id,
      confirmedAt: new Date(),
      ourLegalEntityId: snapshot.ourLegalEntityId,
      vatRate: snapshot.vatRate,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_CREATED',
      entityType: 'Order',
      entityId: order.id,
      payload: {
        clientId: data.clientId,
        portions: data.portions,
        totalPrice,
        deliveryDate: deliveryDate.toISOString(),
        manual: true,
      },
    },
  })

  revalidatePath('/orders')
  return {
    ok: true,
    data: {
      id: order.id,
      deliveryDate: deliveryDate.toISOString(),
    },
  }
}

/**
 * Проверяет существует ли уже заказ с такими же ключами (клиент+точка+тип+дата).
 */
export async function findDuplicateOrder(args: {
  clientId: string
  locationId: string
  mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER'
  deliveryDate: string
}): Promise<{
  exists: boolean
  order: { id: string; portions: number; status: string } | null
}> {
  await requireRole(['ADMIN', 'MANAGER'])

  const date = new Date(args.deliveryDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const existing = await prisma.order.findFirst({
    where: {
      clientId: args.clientId,
      locationId: args.locationId,
      mealType: args.mealType,
      deliveryDate: { gte: date, lte: dayEnd },
      status: { not: 'CANCELLED' },
    },
    select: { id: true, portions: true, status: true },
  })

  return {
    exists: !!existing,
    order: existing,
  }
}

/**
 * Возвращает клиента с активными точками и конфигами для формы создания заказа.
 */
export async function getClientForOrderForm(clientId: string) {
  await requireRole(['ADMIN', 'MANAGER'])

  const client = await prisma.client.findUnique({
    where: { id: clientId, isActive: true },
    select: {
      id: true,
      name: true,
      locations: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          address: true,
          packaging: true,
        },
      },
      mealConfigs: {
        where: { isActive: true },
        select: {
          id: true,
          locationId: true,
          mealType: true,
          orderType: true,
          fixedPortions: true,
          pricePerPortion: true,
          deliveryHorizon: true,
        },
      },
    },
  })

  if (!client) return null

  return {
    id: client.id,
    name: client.name,
    locations: client.locations,
    mealConfigs: client.mealConfigs.map((c) => ({
      id: c.id,
      locationId: c.locationId,
      mealType: c.mealType,
      orderType: c.orderType,
      fixedPortions: c.fixedPortions,
      pricePerPortion: Number(c.pricePerPortion),
      deliveryHorizon: c.deliveryHorizon,
    })),
  }
}

/**
 * Ручной запуск генерации FIXED-заказов из UI (кнопка "Досоздать на завтра").
 */
export async function regenerateFixedOrders(targetDateIso: string): Promise<ActionResult<{
  created: number
  skippedExisting: number
  matchedSchedule: number
  candidatesTotal: number
}>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const date = new Date(targetDateIso)
  if (isNaN(date.getTime())) {
    return { ok: false, error: 'Неверная дата' }
  }
  date.setHours(0, 0, 0, 0)

  const stats = await generateFixedOrdersForDate(date, {
    triggeredByUserId: user.id,
  })

  revalidatePath('/orders')
  return {
    ok: true,
    data: {
      created: stats.created,
      skippedExisting: stats.skippedExisting,
      matchedSchedule: stats.matchedSchedule,
      candidatesTotal: stats.candidatesTotal,
    },
  }
}

const confirmOrderSchema = z.object({
  orderId: z.string().min(1),
  portions: z.number().int().nonnegative(),
  expectedUpdatedAt: z.string().optional(),
})

/**
 * Подтверждает DYNAMIC-заказ: проставляет реальное количество порций,
 * меняет статус с PENDING_CONFIRMATION на CONFIRMED, фиксирует время.
 *
 * Если portions = 0 — это явный отказ клиента "сегодня не возим".
 * В этом случае статус становится CANCELLED, и кухне ничего не идёт.
 */
export async function confirmDynamicOrder(
  formData: z.infer<typeof confirmOrderSchema>
): Promise<ActionResult<{ status: 'CONFIRMED' | 'CANCELLED' }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = confirmOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, portions, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt)
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  // Находим заказ — нужна цена для пересчёта totalPrice
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, pricePerPortion: true, clientId: true, locationId: true },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status !== 'PENDING_CONFIRMATION') {
    return { ok: false, error: `Заказ уже в статусе ${order.status}, подтверждение невозможно` }
  }

  const newStatus: 'CONFIRMED' | 'CANCELLED' = portions === 0 ? 'CANCELLED' : 'CONFIRMED'
  const totalPrice = portions * Number(order.pricePerPortion)

  await prisma.order.update({
    where: { id: orderId },
    data: {
      portions,
      totalPrice,
      status: newStatus,
      confirmedAt: new Date(),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: portions === 0 ? 'ORDER_DECLINED' : 'ORDER_CONFIRMED',
      entityType: 'Order',
      entityId: orderId,
      payload: { portions, totalPrice, status: newStatus },
    },
  })

  revalidatePath('/orders')
  revalidatePath('/orders/confirm')
  revalidatePath('/dashboard')
  return { ok: true, data: { status: newStatus } }
}

const editOrderSchema = z.object({
  orderId: z.string().min(1),
  portions: z.number().int().nonnegative(),
  expectedUpdatedAt: z.string().optional(),
})

/**
 * Редактирует порции существующего заказа.
 * Если правка сделана после cut-off дня перед доставкой — проставляет
 * editedAfterLockAt (визуальный маркер). Заблокировать редактирование
 * не может: клиент мог позвонить в 18:30 «извините, нас будет 100 а не 80»,
 * и менеджер ОБЯЗАН зафиксировать это.
 *
 * Не для PENDING_CONFIRMATION — для них есть confirmDynamicOrder.
 * Не для CANCELLED/DELIVERED — это финальные статусы.
 */
export async function editOrderPortions(
  formData: z.infer<typeof editOrderSchema>
): Promise<ActionResult<{ editedAfterLock: boolean }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = editOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, portions, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt)
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      portions: true,
      pricePerPortion: true,
      deliveryDate: true,
      mealType: true,
      client: { select: { name: true } },
      location: { select: { name: true } },
    },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }

  if (order.status === 'PENDING_CONFIRMATION') {
    return { ok: false, error: 'Используйте подтверждение для PENDING-заказов' }
  }
  if (order.status === 'CANCELLED' || order.status === 'DELIVERED' || order.status === 'DRAFT') {
    return { ok: false, error: `Нельзя править заказ в статусе ${order.status}` }
  }

  if (portions === order.portions) {
    return { ok: true, data: { editedAfterLock: false } }
  }

  const afterCutoff = isPastCutoff(order.deliveryDate)
  const totalPrice = portions * Number(order.pricePerPortion)

  await prisma.order.update({
    where: { id: orderId },
    data: {
      portions,
      totalPrice,
      ...(afterCutoff ? { editedAfterLockAt: new Date() } : {}),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_PORTIONS_EDITED',
      entityType: 'Order',
      entityId: orderId,
      payload: {
        oldPortions: order.portions,
        newPortions: portions,
        afterCutoff,
        totalPrice,
      },
    },
  })

  // Push в групповой чат «Будни — Команда» — только при правке после lock.
  // Кухня и курьер должны узнать что их данные устарели. Если push упал —
  // НЕ блокируем save: менеджер уже сохранил, мы только пишем в лог.
  if (afterCutoff) {
    const text =
      `⚠️ <b>Правка заказа после 16:00</b>\n\n` +
      `${escapeHtml(order.client.name)} · ${escapeHtml(order.location.name)}\n` +
      `${MEAL_TYPE_LABELS[order.mealType]} на ${formatDateShort(order.deliveryDate)}\n\n` +
      `Было: <b>${order.portions}</b> → Стало: <b>${portions}</b>\n` +
      `Правил: ${escapeHtml(user.name)}\n\n` +
      `Кухня и курьер: учтите изменения.`

    const pushResult = await notifyGroup(text, {
      parseMode: 'HTML',
      replyMarkup: orderDetailButton(orderId),
    })

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'ORDER_PORTIONS_EDITED_AFTER_LOCK',
        entityType: 'Order',
        entityId: orderId,
        payload: {
          oldPortions: order.portions,
          newPortions: portions,
          notifiedGroup: pushResult.ok,
          pushError: pushResult.ok ? null : (pushResult.error ?? 'unknown'),
        },
      },
    })
  }

  revalidatePath('/orders')
  return { ok: true, data: { editedAfterLock: afterCutoff } }
}

const cancelOrderSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().max(500).nullable().optional(),
  expectedUpdatedAt: z.string().optional(),
})

/**
 * Отменяет заказ. Работает на любом статусе кроме DELIVERED/CANCELLED.
 * Записывает в ActivityLog с причиной.
 */
export async function cancelOrder(
  formData: z.infer<typeof cancelOrderSchema>
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = cancelOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, reason, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt)
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, portions: true, clientId: true, deliveryDate: true },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status === 'CANCELLED') return { ok: false, error: 'Заказ уже отменён' }
  if (order.status === 'DELIVERED') return { ok: false, error: 'Доставленный заказ нельзя отменить' }

  const afterCutoff = isPastCutoff(order.deliveryDate)

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'CANCELLED',
      ...(afterCutoff ? { editedAfterLockAt: new Date() } : {}),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_CANCELLED',
      entityType: 'Order',
      entityId: orderId,
      payload: {
        previousStatus: order.status,
        portions: order.portions,
        reason: reason ?? null,
        afterCutoff,
      },
    },
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${orderId}`)
  return { ok: true, data: undefined }
}

const rescheduleOrderSchema = z.object({
  orderId: z.string().min(1),
  newDate: z.string().min(1),
  expectedUpdatedAt: z.string().optional(),
})

/**
 * Переносит заказ на другую дату. Не должно создавать дубль —
 * проверяем что на новой дате нет другого активного заказа
 * с тем же бизнес-ключом (clientId + locationId + mealType).
 */
export async function rescheduleOrder(
  formData: z.infer<typeof rescheduleOrderSchema>
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = rescheduleOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, newDate, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt)
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      clientId: true,
      locationId: true,
      mealType: true,
      deliveryDate: true,
    },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status === 'CANCELLED' || order.status === 'DELIVERED') {
    return { ok: false, error: `Нельзя перенести заказ в статусе ${order.status}` }
  }

  const target = new Date(newDate)
  if (isNaN(target.getTime())) {
    return { ok: false, error: 'Неверная дата' }
  }
  target.setHours(0, 0, 0, 0)
  const targetEnd = new Date(target)
  targetEnd.setHours(23, 59, 59, 999)

  // Проверка дубля по бизнес-ключу
  const conflict = await prisma.order.findFirst({
    where: {
      clientId: order.clientId,
      locationId: order.locationId,
      mealType: order.mealType,
      deliveryDate: { gte: target, lte: targetEnd },
      status: { not: 'CANCELLED' },
      id: { not: orderId },
    },
    select: { id: true, status: true },
  })

  if (conflict) {
    return {
      ok: false,
      error: `На эту дату уже есть заказ (${conflict.status}). Сначала разберитесь с ним.`,
    }
  }

  // Перенос считается «после cut-off», если ИСХОДНАЯ дата уже за чертой
  // (правки уже могли уйти на кухню/курьеру).
  const afterCutoff = isPastCutoff(order.deliveryDate)

  await prisma.order.update({
    where: { id: orderId },
    data: {
      deliveryDate: target,
      ...(afterCutoff ? { editedAfterLockAt: new Date() } : {}),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_RESCHEDULED',
      entityType: 'Order',
      entityId: orderId,
      payload: {
        oldDate: order.deliveryDate.toISOString(),
        newDate: target.toISOString(),
        afterCutoff,
      },
    },
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${orderId}`)
  return { ok: true, data: undefined }
}


/**
 * Сменить наше юрлицо отгрузки на конкретном заказе. Snapshot vatRate
 * пересчитывается из выбранного юрлица. Доступно ADMIN+MANAGER, только до
 * lock (DRAFT/PENDING_CONFIRMATION/CONFIRMED). После lock — изменение
 * запрещено: УПД мог быть уже сформирован.
 */
const BLOCKED_STATUSES_FOR_LEGAL_ENTITY_CHANGE = [
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const

export async function changeOrderLegalEntity(
  orderId: string,
  newOurLegalEntityId: string
): Promise<ActionResult> {
  const me = await requireRole(['ADMIN', 'MANAGER'])

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, clientId: true, ourLegalEntityId: true },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }

  if ((BLOCKED_STATUSES_FOR_LEGAL_ENTITY_CHANGE as readonly string[]).includes(order.status)) {
    return { ok: false, error: 'Юрлицо нельзя сменить после lock заказа' }
  }

  const newEntity = await prisma.ourLegalEntity.findUnique({
    where: { id: newOurLegalEntityId },
    select: { id: true, isActive: true, vatRate: true, shortName: true },
  })
  if (!newEntity) return { ok: false, error: 'Юрлицо не найдено' }
  if (!newEntity.isActive) return { ok: false, error: 'Это юрлицо архивировано' }

  await prisma.$transaction([
    prisma.order.update({
      where: { id: orderId },
      data: {
        ourLegalEntityId: newEntity.id,
        vatRate: newEntity.vatRate,
      },
    }),
    prisma.activityLog.create({
      data: {
        userId: me.id,
        userRole: me.role,
        action: 'ORDER_LEGAL_ENTITY_CHANGED',
        entityType: 'Order',
        entityId: orderId,
        payload: {
          from: order.ourLegalEntityId,
          to: newEntity.id,
          shortName: newEntity.shortName,
        },
      },
    }),
  ])

  revalidatePath('/orders')
  revalidatePath(`/orders/${orderId}`)
  return { ok: true, data: undefined }
}

// ============================================================
// Sprint 7.16.A.2 — Action-Борис: restore / addNote / createOneTime
// ============================================================

const restoreOrderSchema = z.object({
  orderId: z.string(),
  expectedUpdatedAt: z.coerce.date().optional(),
})

/**
 * Восстанавливает отменённый заказ: переводит CANCELLED → CONFIRMED.
 * Если уже прошёл cut-off, выставляет editedAfterLockAt (визуальный маркер
 * "правка после lock") и пишет специальный action в ActivityLog —
 * кухня/курьер должны узнать что их данные снова актуальны.
 */
export async function restoreOrder(
  formData: z.infer<typeof restoreOrderSchema>
): Promise<ActionResult<{ editedAfterLock: boolean }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = restoreOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt?.toISOString())
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      deliveryDate: true,
      editedAfterLockAt: true,
    },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status !== 'CANCELLED') {
    return { ok: false, error: 'Заказ не в статусе CANCELLED — нечего восстанавливать' }
  }

  const afterCutoff = isPastCutoff(order.deliveryDate)
  const restoredAt = new Date()

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'CONFIRMED',
      confirmedAt: restoredAt,
      lockedAt: null,
      ...(afterCutoff ? { editedAfterLockAt: restoredAt } : {}),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: afterCutoff ? 'ORDER_RESTORED_AFTER_LOCK' : 'ORDER_RESTORED',
      entityType: 'Order',
      entityId: orderId,
      payload: {
        previousStatus: 'CANCELLED',
        restoredAt: restoredAt.toISOString(),
        afterCutoff,
      },
    },
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${orderId}`)
  return { ok: true, data: { editedAfterLock: afterCutoff } }
}

const addOrderNoteSchema = z.object({
  orderId: z.string(),
  note: z.string().min(1).max(500),
  expectedUpdatedAt: z.coerce.date().optional(),
})

/**
 * Добавляет заметку к заказу. Не перезаписывает существующие — аппендит
 * с timestamp-разделителем, чтобы сохранять историю комментариев менеджеров
 * (и Бориса).
 *
 * Не разрешено для CANCELLED/DELIVERED: финальные статусы, добавлять туда
 * новые заметки — путать аудит.
 */
export async function addOrderNote(
  formData: z.infer<typeof addOrderNoteSchema>
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = addOrderNoteSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const { orderId, note, expectedUpdatedAt } = parsed.data

  try {
    await assertOrderUpdatedAt(orderId, expectedUpdatedAt?.toISOString())
  } catch (e) {
    if (e instanceof OptimisticLockError) return { ok: false, error: e.message }
    throw e
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, notes: true },
  })
  if (!order) return { ok: false, error: 'Заказ не найден' }
  if (order.status === 'CANCELLED' || order.status === 'DELIVERED') {
    return { ok: false, error: `Нельзя добавить заметку к заказу в статусе ${order.status}` }
  }

  const previousNotesLength = order.notes?.length ?? 0
  const newNotes = order.notes && order.notes.length > 0
    ? `${order.notes}\n---\n[${new Date().toISOString()}] ${note}`
    : note

  await prisma.order.update({
    where: { id: orderId },
    data: { notes: newNotes },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_NOTE_ADDED',
      entityType: 'Order',
      entityId: orderId,
      payload: {
        note,
        previousNotesLength,
      },
    },
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${orderId}`)
  return { ok: true, data: undefined }
}

const createOneTimeOrderSchema = z.object({
  clientId: z.string(),
  locationId: z.string(),
  mealType: z.nativeEnum(MealType),
  deliveryDate: z.coerce.date(),
  portions: z.number().int().positive(),
  pricePerPortion: z.number().positive().optional(),
})

/**
 * Создаёт разовый заказ от лица AI-агента "Борис". Резолвит цену из
 * (1) переданного параметра → (2) активного ClientMealConfig → (3) последнего
 * confirmed заказа клиента с таким же mealType. Если ничего не нашлось —
 * ошибка, менеджер должен указать цену явно.
 *
 * Дубль-проверка по бизнес-ключу {clientId, locationId, mealType, deliveryDate}
 * — иначе вместо createOneTimeOrder надо использовать editOrderPortions.
 */
export async function createOneTimeOrder(
  formData: z.infer<typeof createOneTimeOrderSchema>
): Promise<ActionResult<{ orderId: string }>> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const parsed = createOneTimeOrderSchema.safeParse(formData)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }
  }

  const data = parsed.data
  const deliveryDate = new Date(data.deliveryDate)
  deliveryDate.setHours(0, 0, 0, 0)

  const client = await prisma.client.findUnique({
    where: { id: data.clientId },
    select: { id: true, isActive: true },
  })
  if (!client) return { ok: false, error: 'Клиент не найден' }

  const location = await prisma.clientLocation.findUnique({
    where: { id: data.locationId },
    select: { id: true, clientId: true, packaging: true, tags: true, isActive: true },
  })
  if (!location) return { ok: false, error: 'Точка не найдена' }
  if (location.clientId !== data.clientId) {
    return { ok: false, error: 'Локация не принадлежит клиенту' }
  }

  // Антидубль по бизнес-ключу
  const dayEnd = new Date(deliveryDate)
  dayEnd.setHours(23, 59, 59, 999)
  const existing = await prisma.order.findFirst({
    where: {
      clientId: data.clientId,
      locationId: data.locationId,
      mealType: data.mealType,
      deliveryDate: { gte: deliveryDate, lte: dayEnd },
      status: { not: 'CANCELLED' },
    },
    select: { id: true },
  })
  if (existing) {
    return {
      ok: false,
      error: `На эту дату уже есть заказ ${existing.id}, используй editOrderPortions`,
    }
  }

  // Резолв цены: param → активный config → последний confirmed заказ
  let pricePerPortion: number | null = null
  let priceSource: 'param' | 'config' | 'last_order' | null = null

  if (data.pricePerPortion !== undefined) {
    pricePerPortion = data.pricePerPortion
    priceSource = 'param'
  } else {
    const config = await prisma.clientMealConfig.findFirst({
      where: {
        clientId: data.clientId,
        locationId: data.locationId,
        mealType: data.mealType,
        isActive: true,
        validFrom: { lte: deliveryDate },
        OR: [
          { validTo: null },
          { validTo: { gte: deliveryDate } },
        ],
      },
      select: { pricePerPortion: true },
      orderBy: { validFrom: 'desc' },
    })

    if (config) {
      pricePerPortion = Number(config.pricePerPortion)
      priceSource = 'config'
    } else {
      const lastOrder = await prisma.order.findFirst({
        where: {
          clientId: data.clientId,
          mealType: data.mealType,
          status: 'CONFIRMED',
        },
        orderBy: { deliveryDate: 'desc' },
        select: { pricePerPortion: true },
      })

      if (lastOrder) {
        pricePerPortion = Number(lastOrder.pricePerPortion)
        priceSource = 'last_order'
      }
    }
  }

  if (pricePerPortion === null || priceSource === null) {
    return {
      ok: false,
      error: 'Не удалось определить цену — укажи pricePerPortion явно',
    }
  }

  const totalPrice = data.portions * pricePerPortion
  const now = new Date()
  const snapshot = await getOrderLegalEntitySnapshot(data.clientId)

  const newOrder = await prisma.order.create({
    data: {
      clientId: data.clientId,
      locationId: data.locationId,
      mealType: data.mealType,
      deliveryDate,
      portions: data.portions,
      pricePerPortion,
      totalPrice,
      packaging: location.packaging,
      source: 'BORIS',
      status: 'CONFIRMED',
      confirmedAt: now,
      ourLegalEntityId: snapshot.ourLegalEntityId,
      vatRate: snapshot.vatRate,
      tags: location.tags ?? [],
      createdById: user.id,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'ORDER_CREATED_BY_BORIS',
      entityType: 'Order',
      entityId: newOrder.id,
      payload: {
        clientId: data.clientId,
        locationId: data.locationId,
        mealType: data.mealType,
        deliveryDate: deliveryDate.toISOString(),
        portions: data.portions,
        totalPrice,
        pricePerPortion,
        priceSource,
      },
    },
  })

  revalidatePath('/orders')
  return { ok: true, data: { orderId: newOrder.id } }
}
