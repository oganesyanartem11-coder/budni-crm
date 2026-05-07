'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateFixedOrdersForDate } from '@/lib/orders/generate-fixed'

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

  const { orderId, portions } = parsed.data

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
