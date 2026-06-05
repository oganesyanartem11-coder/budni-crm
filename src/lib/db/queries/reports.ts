import { prisma } from '@/lib/db/prisma'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import {
  deliveryRevenueByDay,
  deliveryRevenueByClient,
} from '@/lib/db/queries/delivery-revenue'

export interface DailyPoint {
  date: string
  label: string
  /** Выручка по еде (sum totalPrice) — формула не менялась. */
  revenue: number
  /** Сервисная выручка (доставка) за день. Волна 4: отдельное поле. */
  deliveryRevenue: number
  orders: number
  portions: number
}

export interface ReportClient {
  clientId: string
  clientName: string
  /** Выручка по еде — НЕ менялась. */
  revenue: number
  /** Сервисная выручка (доставка) клиента за период. Волна 4: отдельное поле. */
  deliveryRevenue: number
  ordersCount: number
  portions: number
}

export interface FinancialReport {
  from: string
  to: string
  daysInPeriod: number
  /** Выручка по еде за период — историческое поле. */
  totalRevenue: number
  /** Сервисная выручка (доставка) за период. Волна 4: отдельное поле. */
  deliveryRevenue: number
  totalOrders: number
  totalPortions: number
  totalCancelled: number
  cancelledRate: number
  averageOrder: number
  averagePerDay: number
  daily: DailyPoint[]
  clients: ReportClient[]
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

  // Волна 4: сервисная выручка (доставка) по дням и по клиентам за период.
  // Хелпер дедупит fee один раз на (локация, день), null-fee игнорит.
  const [allOrders, deliveryByDay, deliveryByClient] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: start, lte: end },
      },
      select: {
        id: true,
        deliveryDate: true,
        portions: true,
        totalPrice: true,
        status: true,
        clientId: true,
        client: { select: { id: true, name: true } },
      },
    }),
    deliveryRevenueByDay({ from: start, to: end }),
    deliveryRevenueByClient({ from: start, to: end }),
  ])

  const deliveryByDayKey = new Map<string, number>()
  let deliveryRevenue = 0
  for (const d of deliveryByDay) {
    const key = d.date.toISOString().slice(0, 10)
    const v = Number(d.deliveryRevenue)
    deliveryByDayKey.set(key, (deliveryByDayKey.get(key) ?? 0) + v)
    deliveryRevenue += v
  }
  const deliveryByClientId = new Map<string, number>()
  for (const c of deliveryByClient) {
    deliveryByClientId.set(c.clientId, Number(c.deliveryRevenue))
  }

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

  const dailyMap = new Map<string, { revenue: number; deliveryRevenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 0; i < daysInPeriod; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    dailyMap.set(key, {
      revenue: 0,
      deliveryRevenue: deliveryByDayKey.get(key) ?? 0,
      orders: 0,
      portions: 0,
      date: d,
    })
  }

  const clientMap = new Map<string, ReportClient>()

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
      c = { clientId: o.clientId, clientName: o.client.name, revenue: 0, deliveryRevenue: 0, ordersCount: 0, portions: 0 }
      clientMap.set(o.clientId, c)
    }
    c.revenue += price
    c.ordersCount += 1
    c.portions += o.portions
  }

  // Привязываем сервисную выручку к клиентам (отдельно от food-revenue).
  for (const c of clientMap.values()) {
    c.deliveryRevenue = deliveryByClientId.get(c.clientId) ?? 0
  }

  const daily: DailyPoint[] = Array.from(dailyMap.values()).map((v) => ({
    date: v.date.toISOString().slice(0, 10),
    label: dailyLabel(v.date, daysInPeriod),
    revenue: v.revenue,
    deliveryRevenue: v.deliveryRevenue,
    orders: v.orders,
    portions: v.portions,
  }))

  const clients = Array.from(clientMap.values()).sort((a, b) => b.revenue - a.revenue)

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    daysInPeriod,
    totalRevenue,
    deliveryRevenue,
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
  }
}
