import { prisma } from '@/lib/db/prisma'
import { getFinancialWeekForDbDate } from '@/lib/utils/week'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { deliveryRevenueByLocation } from '@/lib/db/queries/delivery-revenue'
import type { MealType } from '@prisma/client'

export interface PeriodPoint {
  key: string
  label: string
  revenue: number
  orders: number
  portions: number
}

export interface MealTypeBreakdown {
  mealType: MealType
  portions: number
  revenue: number
  ordersCount: number
}

export interface LocationBreakdown {
  locationId: string
  locationName: string
  /** Выручка по еде (sum totalPrice) — НЕ менялась. */
  revenue: number
  /**
   * Сервисная выручка (доставка) по локации за период. Волна 4: отдельное поле,
   * НЕ смешивается с food-выручкой `revenue`.
   */
  deliveryRevenue: number
  portions: number
  ordersCount: number
}

export interface ClientAnalytics {
  clientId: string
  /** Выручка по еде за период — историческое поле, формула не менялась. */
  totalRevenue: number
  /** Сервисная выручка (доставка) клиента за период. Волна 4: отдельное поле. */
  deliveryRevenue: number
  totalOrders: number
  totalPortions: number
  totalCancelled: number
  cancelledRate: number
  averageOrder: number
  averagePortions: number
  weekly: PeriodPoint[]
  monthly: PeriodPoint[]
  mealTypes: MealTypeBreakdown[]
  locations: LocationBreakdown[]
}

const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const RU_MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Финансовая неделя Сб→Пт в @db.Date-семантике: from = UTC-полночь субботы,
 * last = UTC-полночь пятницы. Раньше брали getFinancialWeek().from (МСК-инстант
 * Пт 21:00Z) и читали getDate() на UTC-сервере → подписи «Пт–Пт» (16–23 окт
 * вместо 17–23 окт).
 */
function financialWeekDays(date: Date): { from: Date; last: Date } {
  const { from } = getFinancialWeekForDbDate(date)
  return { from, last: new Date(from.getTime() + 6 * DAY_MS) }
}

function financialWeekKey(date: Date): string {
  return financialWeekDays(date).from.toISOString().slice(0, 10)
}

function financialWeekLabel(date: Date): string {
  const { from, last } = financialWeekDays(date)
  const sameMonth = from.getUTCMonth() === last.getUTCMonth()
  if (sameMonth) {
    return `${from.getUTCDate()}–${last.getUTCDate()} ${RU_MONTHS[from.getUTCMonth()]}`
  }
  return `${from.getUTCDate()} ${RU_MONTHS[from.getUTCMonth()]} – ${last.getUTCDate()} ${RU_MONTHS[last.getUTCMonth()]}`
}

// date — UTC-полночь календарного дня (@db.Date или результат getMskCalendarDayUtc).
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}`
}

function monthLabel(date: Date): string {
  return `${RU_MONTHS_FULL[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export async function getClientAnalytics(clientId: string): Promise<ClientAnalytics> {
  const now = new Date()
  // Все границы — UTC-полночи МСК-дней (@db.Date). Окно: 1-е число месяца
  // 12 мес. назад … МСК-сегодня включительно. Раньше `lte: now` на UTC-сервере
  // в 00:00–03:00 МСК отрезал сегодняшний день, а setMonth/setHours считали
  // месяц по UTC.
  const todayDb = getMskCalendarDayUtc(now, 0)
  const tomorrowDb = getMskCalendarDayUtc(now, 1)
  const startMonths = new Date(Date.UTC(todayDb.getUTCFullYear(), todayDb.getUTCMonth() - 12, 1))

  // Волна 4: сервисная выручка (доставка) по локациям за тот же 12-мес. период.
  // Хелпер отдаёт по всем клиентам — фильтруем по clientId и индексируем по
  // locationId. Доставка хранится ОТДЕЛЬНО от food-выручки (в маржу не входит).
  const [allOrders, deliveryByLocation] = await Promise.all([
    prisma.order.findMany({
      where: {
        clientId,
        deliveryDate: { gte: startMonths, lt: tomorrowDb },
      },
      select: {
        id: true,
        deliveryDate: true,
        mealType: true,
        portions: true,
        totalPrice: true,
        status: true,
        locationId: true,
        location: { select: { id: true, name: true } },
      },
    }),
    // half-open [from, to): to = МСК-завтра (раньше `to: now` с `lt` терял сегодня).
    deliveryRevenueByLocation({ from: startMonths, to: tomorrowDb }),
  ])

  const deliveryByLocationId = new Map<string, number>()
  let deliveryRevenue = 0
  for (const row of deliveryByLocation) {
    if (row.clientId !== clientId) continue
    const v = Number(row.deliveryRevenue)
    deliveryByLocationId.set(row.locationId, v)
    deliveryRevenue += v
  }

  const activeOrders = allOrders.filter((o) => REVENUE_STATUSES.includes(o.status))
  const cancelledCount = allOrders.filter((o) => o.status === 'CANCELLED').length

  let totalRevenue = 0
  let totalPortions = 0
  for (const o of activeOrders) {
    totalRevenue += Number(o.totalPrice)
    totalPortions += o.portions
  }

  const cancelledRate = allOrders.length > 0
    ? Math.round((cancelledCount / allOrders.length) * 1000) / 10
    : 0
  const averageOrder = activeOrders.length > 0 ? totalRevenue / activeOrders.length : 0
  const averagePortions = activeOrders.length > 0 ? totalPortions / activeOrders.length : 0

  const mealMap = new Map<MealType, MealTypeBreakdown>()
  for (const o of activeOrders) {
    let mt = mealMap.get(o.mealType)
    if (!mt) {
      mt = { mealType: o.mealType, portions: 0, revenue: 0, ordersCount: 0 }
      mealMap.set(o.mealType, mt)
    }
    mt.portions += o.portions
    mt.revenue += Number(o.totalPrice)
    mt.ordersCount += 1
  }
  const mealTypes = Array.from(mealMap.values()).sort((a, b) => b.revenue - a.revenue)

  const locationMap = new Map<string, LocationBreakdown>()
  for (const o of activeOrders) {
    let loc = locationMap.get(o.locationId)
    if (!loc) {
      loc = {
        locationId: o.locationId,
        locationName: o.location.name,
        revenue: 0,
        deliveryRevenue: 0,
        portions: 0,
        ordersCount: 0,
      }
      locationMap.set(o.locationId, loc)
    }
    loc.revenue += Number(o.totalPrice)
    loc.portions += o.portions
    loc.ordersCount += 1
  }
  // Привязываем сервисную выручку к локациям (отдельно от food-revenue).
  for (const loc of locationMap.values()) {
    loc.deliveryRevenue = deliveryByLocationId.get(loc.locationId) ?? 0
  }
  const locations = Array.from(locationMap.values()).sort((a, b) => b.revenue - a.revenue)

  const weeklyMap = new Map<string, { revenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(todayDb.getTime() - i * 7 * DAY_MS)
    const key = financialWeekKey(d)
    if (!weeklyMap.has(key)) {
      weeklyMap.set(key, { revenue: 0, orders: 0, portions: 0, date: financialWeekDays(d).from })
    }
  }

  const monthlyMap = new Map<string, { revenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(todayDb.getUTCFullYear(), todayDb.getUTCMonth() - i, 1))
    const key = monthKey(d)
    if (!monthlyMap.has(key)) {
      monthlyMap.set(key, { revenue: 0, orders: 0, portions: 0, date: d })
    }
  }

  for (const o of activeOrders) {
    const wKey = financialWeekKey(o.deliveryDate)
    const w = weeklyMap.get(wKey)
    if (w) {
      w.revenue += Number(o.totalPrice)
      w.orders += 1
      w.portions += o.portions
    }

    const mKey = monthKey(o.deliveryDate)
    const m = monthlyMap.get(mKey)
    if (m) {
      m.revenue += Number(o.totalPrice)
      m.orders += 1
      m.portions += o.portions
    }
  }

  const weekly: PeriodPoint[] = Array.from(weeklyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      key,
      label: financialWeekLabel(val.date),
      revenue: val.revenue,
      orders: val.orders,
      portions: val.portions,
    }))

  const monthly: PeriodPoint[] = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      key,
      label: monthLabel(val.date),
      revenue: val.revenue,
      orders: val.orders,
      portions: val.portions,
    }))

  return {
    clientId,
    totalRevenue,
    deliveryRevenue,
    totalOrders: activeOrders.length,
    totalPortions,
    totalCancelled: cancelledCount,
    cancelledRate,
    averageOrder,
    averagePortions,
    weekly,
    monthly,
    mealTypes,
    locations,
  }
}
