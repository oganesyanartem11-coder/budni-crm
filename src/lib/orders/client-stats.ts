import { prisma } from '@/lib/db/prisma'
import type { OrderStatus } from '@prisma/client'

// Статусы, которые считаются «нормальной» историей для статистики.
// Локальный массив — не путать с ACTIVE_ORDER_STATUSES из constants/order.ts
// (тот включает PENDING_CONFIRMATION и не включает DELIVERED).
const STATS_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

export interface ClientStats {
  averageByDayOfWeek: number | null
  sampleSize: number
  recentOrders: Array<{
    date: Date
    locationName: string
    portions: number
  }>
  typicalRange: { min: number; max: number } | null
}

/**
 * Статистика клиента для детектора аномалий и LLM-контекста.
 * Берёт заказы за последние 60 дней (без CANCELLED), считает среднее
 * ТОЛЬКО по тому же дню недели что нужен для прогноза.
 *
 * Не путать с getClientAnalytics из db/queries/client-analytics.ts —
 * та считает выручку/чек/тренды для UI «Аналитика клиента»; здесь
 * нужны другие агрегаты, поэтому отдельная функция.
 *
 * @param dayOfWeek 0=Sun, 1=Mon, ... 6=Sat (формат JS Date.getUTCDay())
 */
export async function getClientStats(
  clientId: string,
  dayOfWeek: number
): Promise<ClientStats> {
  const sixtyDaysAgo = new Date()
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

  const orders = await prisma.order.findMany({
    where: {
      clientId,
      deliveryDate: { gte: sixtyDaysAgo },
      status: { in: STATS_STATUSES },
    },
    include: {
      location: { select: { name: true } },
    },
    orderBy: { deliveryDate: 'desc' },
    take: 100,
  })

  const sameDayOrders = orders.filter((o) => o.deliveryDate.getUTCDay() === dayOfWeek)
  const averageByDayOfWeek =
    sameDayOrders.length > 0
      ? Math.round(sameDayOrders.reduce((sum, o) => sum + o.portions, 0) / sameDayOrders.length)
      : null

  const recentOrders = orders.slice(0, 5).map((o) => ({
    date: o.deliveryDate,
    locationName: o.location.name,
    portions: o.portions,
  }))

  const allPortions = orders.map((o) => o.portions)
  const typicalRange =
    allPortions.length > 0
      ? { min: Math.min(...allPortions), max: Math.max(...allPortions) }
      : null

  return {
    averageByDayOfWeek,
    sampleSize: sameDayOrders.length,
    recentOrders,
    typicalRange,
  }
}
