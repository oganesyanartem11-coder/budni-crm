import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { ACTIVE_ORDER_STATUSES } from '@/lib/constants/order'

// «Реальные» заказы дня: в работе + доставленные. Исключает DRAFT и CANCELLED.
// Тот же набор, что в src/app/(app)/dashboard/page.tsx — чтобы hero-цифры
// совпадали со StatCard'ами.
const REAL_ORDER_STATUSES: OrderStatus[] = [...ACTIVE_ORDER_STATUSES, 'DELIVERED']

export type TodayHeroData = {
  portions: number
  orderCount: number
  clientCount: number
  deltaPctVsLastWeek: number | null
}

export type TomorrowHeroData = {
  portions: number
  orderCount: number
  status: 'pending' | 'confirmed'
}

// Границы суток — локальное время сервера, как в текущем page.tsx
// (new Date().setHours(0,0,0,0)). deliveryDate в схеме — @db.Date (date-only),
// поэтому время в границах фактически не важно; главное — совпасть с дашбордом.
// Возвращаем [start, end) — start включительно, end (= след. полночь) нет.
function dayBounds(base: Date): { start: Date; end: Date } {
  const start = new Date(base)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

/**
 * Hero-данные за сегодня: порции, число заказов, число уникальных клиентов
 * и дельта порций vs тот же день недели 7 дней назад.
 */
export async function getTodayHeroData(now: Date = new Date()): Promise<TodayHeroData> {
  const { start, end } = dayBounds(now)
  const lastWeek = dayBounds(addDays(now, -7))

  const [agg, distinctClients, lastWeekAgg] = await Promise.all([
    prisma.order.aggregate({
      where: { deliveryDate: { gte: start, lt: end }, status: { in: REAL_ORDER_STATUSES } },
      _count: { id: true },
      _sum: { portions: true },
    }),
    // Уникальные клиенты дня: groupBy по clientId → длина массива.
    prisma.order.groupBy({
      by: ['clientId'],
      where: { deliveryDate: { gte: start, lt: end }, status: { in: REAL_ORDER_STATUSES } },
    }),
    prisma.order.aggregate({
      where: {
        deliveryDate: { gte: lastWeek.start, lt: lastWeek.end },
        status: { in: REAL_ORDER_STATUSES },
      },
      _sum: { portions: true },
    }),
  ])

  const portions = agg._sum.portions ?? 0
  const lastWeekPortions = lastWeekAgg._sum.portions ?? 0

  // delta: ((today - lastWeek)/lastWeek)*100, 1 знак. null если базы нет (==0),
  // чтобы не делить на ноль и не показывать ложный «+∞%».
  const deltaPctVsLastWeek =
    lastWeekPortions > 0
      ? Math.round(((portions - lastWeekPortions) / lastWeekPortions) * 1000) / 10
      : null

  return {
    portions,
    orderCount: agg._count.id,
    clientCount: distinctClients.length,
    deltaPctVsLastWeek,
  }
}

/**
 * Hero-данные за завтра: порции, число заказов и агрегированный статус.
 */
export async function getTomorrowHeroData(now: Date = new Date()): Promise<TomorrowHeroData> {
  const { start, end } = dayBounds(addDays(now, 1))

  const [agg, pendingCount] = await Promise.all([
    prisma.order.aggregate({
      where: { deliveryDate: { gte: start, lt: end }, status: { in: REAL_ORDER_STATUSES } },
      _count: { id: true },
      _sum: { portions: true },
    }),
    prisma.order.count({
      where: {
        deliveryDate: { gte: start, lt: end },
        status: 'PENDING_CONFIRMATION',
      },
    }),
  ])

  // 'confirmed' когда нет ни одного PENDING_CONFIRMATION среди завтрашних заказов.
  // При 0 заказов pendingCount тоже 0 → 'confirmed': подтверждать нечего, и UI
  // не должен сигналить тревогу на пустом дне (трактуем как «всё ок»).
  const status: TomorrowHeroData['status'] = pendingCount === 0 ? 'confirmed' : 'pending'

  return {
    portions: agg._sum.portions ?? 0,
    orderCount: agg._count.id,
    status,
  }
}

/**
 * Грубый «рекорд дня» — максимум суммы порций за один день за последние 30 дней.
 * TODO Волна 6: заменить на честный dailyRecord-трекинг (отдельная таблица/поле),
 * а не пересчёт по 30-дневному окну на каждый рендер.
 */
export async function getRoughDailyRecord(now: Date = new Date()): Promise<number> {
  const { end } = dayBounds(now)
  const windowStart = dayBounds(addDays(now, -30)).start

  // groupBy по дню сразу: deliveryDate — @db.Date, так что у каждой даты ровно
  // одно значение в ключе (без времени) → суммы корректно бьются по суткам.
  const grouped = await prisma.order.groupBy({
    by: ['deliveryDate'],
    where: { deliveryDate: { gte: windowStart, lt: end }, status: { in: REAL_ORDER_STATUSES } },
    _sum: { portions: true },
  })

  let max = 0
  for (const g of grouped) {
    const p = g._sum.portions ?? 0
    if (p > max) max = p
  }
  return max
}
