import { prisma } from '@/lib/db/prisma'
import { getFinancialWeek, getPreviousFinancialWeek } from '@/lib/utils/week'
import type { OrderStatus, MealType } from '@prisma/client'

const REVENUE_STATUSES: OrderStatus[] = [
  'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY', 'DELIVERED',
]

export interface DailyRevenuePoint {
  date: string
  dayLabel: string
  revenue: number
  orders: number
}

export interface TopClient {
  clientId: string
  clientName: string
  revenue: number
  ordersCount: number
}

export interface MealTypeDistribution {
  mealType: MealType
  portions: number
  revenue: number
}

export interface AdminDashboardData {
  weekFrom: string
  weekTo: string
  thisWeek: {
    totalRevenue: number
    totalOrders: number
    totalPortions: number
    daily: DailyRevenuePoint[]
  }
  prevWeek: {
    totalRevenue: number
    totalOrders: number
  }
  revenueChangePct: number | null
  topClients: TopClient[]
  mealTypes: MealTypeDistribution[]
}

const WEEKDAY_NAMES_SHORT_BY_DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

export async function getAdminDashboardData(referenceDate?: Date): Promise<AdminDashboardData> {
  const ref = referenceDate ?? new Date()
  const { from: thisFrom, to: thisTo } = getFinancialWeek(ref)
  const { from: prevFrom, to: prevTo } = getPreviousFinancialWeek(ref)

  const thisWeekOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: thisFrom, lte: thisTo },
      status: { in: REVENUE_STATUSES },
    },
    select: {
      id: true,
      deliveryDate: true,
      mealType: true,
      portions: true,
      totalPrice: true,
      clientId: true,
      client: { select: { id: true, name: true } },
    },
  })

  const prevAgg = await prisma.order.aggregate({
    where: {
      deliveryDate: { gte: prevFrom, lte: prevTo },
      status: { in: REVENUE_STATUSES },
    },
    _sum: { totalPrice: true },
    _count: { id: true },
  })

  const dailyMap = new Map<string, { revenue: number; orders: number }>()
  for (let i = 0; i < 7; i++) {
    const d = new Date(thisFrom)
    d.setDate(thisFrom.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    dailyMap.set(key, { revenue: 0, orders: 0 })
  }

  let totalRevenue = 0
  let totalPortions = 0
  const clientMap = new Map<string, TopClient>()
  const mealTypeMap = new Map<MealType, { portions: number; revenue: number }>()

  for (const o of thisWeekOrders) {
    const key = o.deliveryDate.toISOString().slice(0, 10)
    const day = dailyMap.get(key)
    const price = Number(o.totalPrice)
    if (day) {
      day.revenue += price
      day.orders += 1
    }
    totalRevenue += price
    totalPortions += o.portions

    let c = clientMap.get(o.clientId)
    if (!c) {
      c = { clientId: o.clientId, clientName: o.client.name, revenue: 0, ordersCount: 0 }
      clientMap.set(o.clientId, c)
    }
    c.revenue += price
    c.ordersCount += 1

    let mt = mealTypeMap.get(o.mealType)
    if (!mt) {
      mt = { portions: 0, revenue: 0 }
      mealTypeMap.set(o.mealType, mt)
    }
    mt.portions += o.portions
    mt.revenue += price
  }

  const daily: DailyRevenuePoint[] = []
  for (const [key, val] of dailyMap.entries()) {
    const d = new Date(key + 'T00:00:00')
    const dayLabel = `${WEEKDAY_NAMES_SHORT_BY_DOW[d.getDay()]} ${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, '0')}`
    daily.push({ date: key, dayLabel, revenue: val.revenue, orders: val.orders })
  }

  const topClients = Array.from(clientMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3)

  const mealTypes: MealTypeDistribution[] = (['BREAKFAST', 'LUNCH', 'DINNER'] as MealType[])
    .map((mt) => ({
      mealType: mt,
      portions: mealTypeMap.get(mt)?.portions ?? 0,
      revenue: mealTypeMap.get(mt)?.revenue ?? 0,
    }))
    .filter((x) => x.portions > 0)

  const prevRevenue = Number(prevAgg._sum.totalPrice ?? 0)
  const revenueChangePct = prevRevenue > 0
    ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 1000) / 10
    : null

  return {
    weekFrom: thisFrom.toISOString(),
    weekTo: thisTo.toISOString(),
    thisWeek: {
      totalRevenue,
      totalOrders: thisWeekOrders.length,
      totalPortions,
      daily,
    },
    prevWeek: {
      totalRevenue: prevRevenue,
      totalOrders: prevAgg._count.id,
    },
    revenueChangePct,
    topClients,
    mealTypes,
  }
}
