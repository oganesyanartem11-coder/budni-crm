import { startOfDay, endOfDay } from 'date-fns'
import { prisma } from '@/lib/db/prisma'
import type { OrderStatus, MealType, Prisma } from '@prisma/client'

export interface OrderListFilter {
  dateFrom?: Date
  dateTo?: Date
  clientId?: string
  mealType?: MealType
  status?: OrderStatus
  search?: string
}

/**
 * Список заказов для табличного режима. Сортировка по дате доставки + времени создания.
 */
export async function listOrders(filter: OrderListFilter, limit = 200) {
  const where: Prisma.OrderWhereInput = {}

  if (filter.dateFrom || filter.dateTo) {
    where.deliveryDate = {}
    if (filter.dateFrom) where.deliveryDate.gte = filter.dateFrom
    if (filter.dateTo) where.deliveryDate.lte = filter.dateTo
  }
  if (filter.clientId) where.clientId = filter.clientId
  if (filter.mealType) where.mealType = filter.mealType
  if (filter.status) where.status = filter.status

  if (filter.search && filter.search.trim()) {
    const q = filter.search.trim()
    where.OR = [
      { client: { name: { contains: q, mode: 'insensitive' } } },
      { location: { name: { contains: q, mode: 'insensitive' } } },
    ]
  }

  return prisma.order.findMany({
    where,
    take: limit,
    orderBy: [
      { deliveryDate: 'asc' },
      { client: { name: 'asc' } },
      { mealType: 'asc' },
    ],
    include: {
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true, address: true } },
    },
  })
}

/**
 * Заказы для календарной сетки на неделю — те же фильтры,
 * но с агрегацией по дате/клиенту/типу.
 */
export async function listOrdersForWeek(weekStart: Date) {
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: {
        gte: weekStart,
        lt: weekEnd,
      },
      status: { not: 'CANCELLED' },
    },
    orderBy: [
      { deliveryDate: 'asc' },
      { client: { name: 'asc' } },
    ],
    include: {
      client: { select: { id: true, name: true } },
    },
  })

  return orders
}

/**
 * Список клиентов для фильтра-выпадашки.
 */
export async function listActiveClientsLight() {
  return prisma.client.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
}

/**
 * Сколько заказов ждут подтверждения (для бейджа на дашборде).
 */
export async function countPendingConfirmation() {
  return prisma.order.count({
    where: { status: 'PENDING_CONFIRMATION' },
  })
}

/**
 * Подтверждение DYNAMIC до 16:00. Возвращает все заказы со статусом
 * PENDING_CONFIRMATION на сегодня и завтра.
 *
 * Использование:
 * - countPendingConfirmation для бейджей и шапки
 * - listPendingConfirmation для экрана быстрого ввода
 */
export async function countPendingConfirmationToday() {
  const today = startOfDay(new Date())
  const tomorrowEnd = endOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000))
  return prisma.order.count({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: { gte: today, lte: tomorrowEnd },
    },
  })
}

export async function listPendingConfirmation() {
  const today = startOfDay(new Date())
  const tomorrowEnd = endOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000))
  return prisma.order.findMany({
    where: {
      status: 'PENDING_CONFIRMATION',
      deliveryDate: { gte: today, lte: tomorrowEnd },
    },
    orderBy: [
      { deliveryDate: 'asc' },
      { client: { name: 'asc' } },
      { mealType: 'asc' },
    ],
    include: {
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true, address: true } },
      sourceConfig: { select: { id: true, fixedPortions: true } },
    },
  })
}

/**
 * Возвращает заказ со всеми связями для детальной карточки
 * + историю изменений из ActivityLog по этому orderId.
 */
export async function getOrderDetail(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      client: { select: { id: true, name: true, contactName: true, contactPhone: true } },
      location: { select: { id: true, name: true, address: true, packaging: true, tags: true, deliveryWindowFrom: true, deliveryWindowTo: true } },
      sourceConfig: { select: { id: true, orderType: true, scheduleType: true, fixedPortions: true } },
      createdBy: { select: { id: true, name: true, role: true } },
      delivery: { select: { id: true, status: true, deliveredAt: true, courierName: true } },
    },
  })

  if (!order) return null

  const history = await prisma.activityLog.findMany({
    where: {
      entityType: 'Order',
      entityId: orderId,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      user: { select: { id: true, name: true, role: true } },
    },
  })

  return { order, history }
}
