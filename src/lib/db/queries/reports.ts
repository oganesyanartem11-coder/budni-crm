import { prisma } from '@/lib/db/prisma'
import type { OrderStatus, MealType } from '@prisma/client'

const REVENUE_STATUSES: OrderStatus[] = [
  'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY', 'DELIVERED',
]

export interface DailyPoint {
  date: string
  label: string
  revenue: number
  orders: number
  portions: number
}

export interface ReportClient {
  clientId: string
  clientName: string
  revenue: number
  ordersCount: number
  portions: number
}

export interface ReportMealType {
  mealType: MealType
  revenue: number
  portions: number
  ordersCount: number
}

export interface FinancialReport {
  from: string
  to: string
  daysInPeriod: number
  totalRevenue: number
  totalOrders: number
  totalPortions: number
  totalCancelled: number
  cancelledRate: number
  averageOrder: number
  averagePerDay: number
  daily: DailyPoint[]
  clients: ReportClient[]
  mealTypes: ReportMealType[]
}

const RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function dailyLabel(date: Date, daysInPeriod: number): string {
  if (daysInPeriod > 60) {
    return `${date.getDate()}.${(date.getMonth() + 1).toString().padStart(2, '0')}`
  }
  return `${date.getDate()} ${RU_MONTHS_SHORT[date.getMonth()]}`
}

export async function getFinancialReport(from: Date, to: Date): Promise<FinancialReport> {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(23, 59, 59, 999)

  const allOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: start, lte: end },
    },
    select: {
      id: true,
      deliveryDate: true,
      mealType: true,
      portions: true,
      totalPrice: true,
      status: true,
      clientId: true,
      client: { select: { id: true, name: true } },
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

  const daysInPeriod = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  )

  const dailyMap = new Map<string, { revenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 0; i < daysInPeriod; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    dailyMap.set(key, { revenue: 0, orders: 0, portions: 0, date: d })
  }

  const clientMap = new Map<string, ReportClient>()
  const mealTypeMap = new Map<MealType, ReportMealType>()

  for (const o of activeOrders) {
    const dayKey = o.deliveryDate.toISOString().slice(0, 10)
    const day = dailyMap.get(dayKey)
    const price = Number(o.totalPrice)
    if (day) {
      day.revenue += price
      day.orders += 1
      day.portions += o.portions
    }

    let c = clientMap.get(o.clientId)
    if (!c) {
      c = { clientId: o.clientId, clientName: o.client.name, revenue: 0, ordersCount: 0, portions: 0 }
      clientMap.set(o.clientId, c)
    }
    c.revenue += price
    c.ordersCount += 1
    c.portions += o.portions

    let mt = mealTypeMap.get(o.mealType)
    if (!mt) {
      mt = { mealType: o.mealType, revenue: 0, portions: 0, ordersCount: 0 }
      mealTypeMap.set(o.mealType, mt)
    }
    mt.revenue += price
    mt.portions += o.portions
    mt.ordersCount += 1
  }

  const daily: DailyPoint[] = Array.from(dailyMap.values()).map((v) => ({
    date: v.date.toISOString().slice(0, 10),
    label: dailyLabel(v.date, daysInPeriod),
    revenue: v.revenue,
    orders: v.orders,
    portions: v.portions,
  }))

  const clients = Array.from(clientMap.values()).sort((a, b) => b.revenue - a.revenue)
  const mealTypes = Array.from(mealTypeMap.values()).sort((a, b) => b.revenue - a.revenue)

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    daysInPeriod,
    totalRevenue,
    totalOrders: activeOrders.length,
    totalPortions,
    totalCancelled: cancelledCount,
    cancelledRate: allOrders.length > 0
      ? Math.round((cancelledCount / allOrders.length) * 1000) / 10
      : 0,
    averageOrder: activeOrders.length > 0 ? totalRevenue / activeOrders.length : 0,
    averagePerDay: totalRevenue / daysInPeriod,
    daily,
    clients,
    mealTypes,
  }
}
