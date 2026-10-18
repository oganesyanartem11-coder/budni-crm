import { prisma } from '@/lib/db/prisma'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { toDbDateRange, countDbDays } from '@/lib/utils/week'
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

// date — UTC-полночь календарного дня (@db.Date) → читаем UTC-компоненты.
function dailyLabel(date: Date, daysInPeriod: number): string {
  if (daysInPeriod > 60) {
    return `${date.getUTCDate()}.${(date.getUTCMonth() + 1).toString().padStart(2, '0')}`
  }
  return `${date.getUTCDate()} ${RU_MONTHS_SHORT[date.getUTCMonth()]}`
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Финансовый отчёт за ВКЛЮЧИТЕЛЬНЫЙ диапазон МСК-дней [from, to].
 * from/to — UTC-полночь дня, МСК-инстант полуночи или любой момент внутри
 * МСК-дня (см. toDbDateRange). Раньше границы строились через серверный
 * setHours (UTC): МСК-инстант Пт 21:00Z → «пятница» (лишний день у this_week).
 */
export async function getFinancialReport(from: Date, to: Date): Promise<FinancialReport> {
  const range = toDbDateRange(from, to)
  const start = range.gte
  // Последняя мс последнего дня в UTC-представлении @db.Date (только для вывода).
  const end = new Date(range.lt.getTime() - 1)

  // Волна 4: сервисная выручка (доставка) по дням и по клиентам за период.
  // Хелпер дедупит fee один раз на (локация, день), null-fee игнорит.
  const [allOrders, deliveryByDay, deliveryByClient] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: range.gte, lt: range.lt },
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
    // delivery-revenue: half-open [from, to) — to = UTC-полночь дня ПОСЛЕ последнего.
    deliveryRevenueByDay({ from: range.gte, to: range.lt }),
    deliveryRevenueByClient({ from: range.gte, to: range.lt }),
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

  const daysInPeriod = Math.max(1, countDbDays(range))

  const dailyMap = new Map<string, { revenue: number; deliveryRevenue: number; orders: number; portions: number; date: Date }>()
  for (let i = 0; i < daysInPeriod; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
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
