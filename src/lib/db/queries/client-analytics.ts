import { prisma } from '@/lib/db/prisma'
import { getFinancialWeek } from '@/lib/utils/week'
import { REVENUE_STATUSES } from '@/lib/constants/order'
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

export interface ClientAnalytics {
  clientId: string
  totalRevenue: number
  totalOrders: number
  totalPortions: number
  totalCancelled: number
  cancelledRate: number
  averageOrder: number
  averagePortions: number
  weekly: PeriodPoint[]
  monthly: PeriodPoint[]
  mealTypes: MealTypeBreakdown[]
}

const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const RU_MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

function financialWeekKey(date: Date): string {
  const { from } = getFinancialWeek(date)
  return from.toISOString().slice(0, 10)
}

function financialWeekLabel(date: Date): string {
  const { from, to } = getFinancialWeek(date)
  const sameMonth = from.getMonth() === to.getMonth()
  if (sameMonth) {
    return `${from.getDate()}–${to.getDate()} ${RU_MONTHS[from.getMonth()]}`
  }
  return `${from.getDate()} ${RU_MONTHS[from.getMonth()]} – ${to.getDate()} ${RU_MONTHS[to.getMonth()]}`
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`
}

function monthLabel(date: Date): string {
  return `${RU_MONTHS_FULL[date.getMonth()]} ${date.getFullYear()}`
}

export async function getClientAnalytics(clientId: string): Promise<ClientAnalytics> {
  const now = new Date()
  const startMonths = new Date(now)
  startMonths.setMonth(startMonths.getMonth() - 12)
  startMonths.setDate(1)
  startMonths.setHours(0, 0, 0, 0)

  const allOrders = await prisma.order.findMany({
    where: {
      clientId,
      deliveryDate: { gte: startMonths, lte: now },
    },
    select: {
      id: true,
      deliveryDate: true,
      mealType: true,
      portions: true,
      totalPrice: true,
      status: true,
    },
  })

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

  const weeklyMap = new Map<string, { revenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i * 7)
    const key = financialWeekKey(d)
    if (!weeklyMap.has(key)) {
      const { from } = getFinancialWeek(d)
      weeklyMap.set(key, { revenue: 0, orders: 0, portions: 0, date: from })
    }
  }

  const monthlyMap = new Map<string, { revenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now)
    d.setMonth(d.getMonth() - i)
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
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
    totalOrders: activeOrders.length,
    totalPortions,
    totalCancelled: cancelledCount,
    cancelledRate,
    averageOrder,
    averagePortions,
    weekly,
    monthly,
    mealTypes,
  }
}
