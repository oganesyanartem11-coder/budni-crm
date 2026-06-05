import { prisma } from '@/lib/db/prisma'
import { getFinancialWeek } from '@/lib/utils/week'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import { toMskDateString } from '@/lib/utils/msk-window'
import {
  sumDeliveryRevenue,
  deliveryRevenueByDay,
} from '@/lib/db/queries/delivery-revenue'

export interface DailyRevenuePoint {
  date: string
  dayLabel: string
  /** Выручка по еде (sum totalPrice) — историческое поле, формула не менялась. */
  revenue: number
  /** Сервисная выручка (доставка) за день. Волна 4: добавлено отдельным полем. */
  deliveryRevenue: number
  orders: number
}

export interface TopClient {
  clientId: string
  clientName: string
  revenue: number
  ordersCount: number
}

export interface AdminDashboardData {
  rangeFrom: string
  rangeTo: string
  thisPeriod: {
    /**
     * Выручка по ЕДЕ (sum Order.totalPrice). Историческое поле — формула и
     * значение НЕ менялись. Совпадает с foodRevenue (alias для совместимости).
     */
    totalRevenue: number
    /** Явный алиас food-выручки (Волна 4) — чтобы потребители не путались. */
    foodRevenue: number
    /** Сервисная выручка (доставка) за период. Волна 4: новое поле. */
    deliveryRevenue: number
    /** food + delivery — общий объём (для отображения, НЕ для маржи). */
    grandTotalRevenue: number
    totalOrders: number
    totalPortions: number
    daily: DailyRevenuePoint[]
  }
  // WoW сравнение присутствует только для week-периодов (this_week / last_week).
  // Для month/year/custom → wow = null, индикатор скрывается.
  wow: {
    changePct: number | null
    comparePrevRevenue: number
    prorated: boolean
    daysCompared: number
    /** Сервисная выручка (доставка) для обоих окон сравнения. Волна 4. */
    deliveryRevenue: number
    comparePrevDeliveryRevenue: number
  } | null
  topClients: TopClient[]
}

const WEEKDAY_NAMES_SHORT_BY_DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

// Daily-график строится для периодов до ~31 дня. Больше — точек слишком
// много, график перестаёт читаться, отдаём пустой массив (UI покажет fallback).
const MAX_DAILY_POINTS = 35

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function daysBetweenInclusive(from: Date, to: Date): number {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime()
  return Math.round(ms / (24 * 60 * 60 * 1000)) + 1
}

function isFinancialWeekRange(from: Date, to: Date): boolean {
  const { from: fwFrom, to: fwTo } = getFinancialWeek(from)
  return (
    startOfDay(from).getTime() === fwFrom.getTime() &&
    endOfDay(to).getTime() === fwTo.getTime()
  )
}

interface Opts {
  /** Сравнение vs предыдущий период (для WoW-бокса). Имеет смысл только для недель. */
  withWoW?: boolean
}

export async function getAdminDashboardData(
  rangeFrom?: Date,
  rangeTo?: Date,
  opts: Opts = {}
): Promise<AdminDashboardData> {
  // Дефолт: текущая финансовая неделя.
  const { from: defaultFrom, to: defaultTo } = getFinancialWeek(new Date())
  const from = rangeFrom ?? defaultFrom
  const to = rangeTo ?? defaultTo

  // Волна 4: сервисная выручка (доставка). Запрашиваем параллельно. Хелпер
  // дедупит fee один раз на (локация, день) и игнорит null-fee. Маржа на эти
  // цифры НЕ опирается — это отдельный «сервисный» поток.
  const [orders, deliveryTotal, deliveryByDay] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: from, lte: to },
        status: { in: REVENUE_STATUSES },
      },
      select: {
        id: true,
        deliveryDate: true,
        portions: true,
        totalPrice: true,
        clientId: true,
        client: { select: { id: true, name: true } },
      },
    }),
    sumDeliveryRevenue({ from, to: endOfDay(to) }),
    deliveryRevenueByDay({ from, to: endOfDay(to) }),
  ])

  const deliveryRevenue = Number(deliveryTotal)

  // daily — только для коротких диапазонов
  const periodDays = daysBetweenInclusive(from, to)
  const buildDaily = periodDays <= MAX_DAILY_POINTS

  const dailyMap = new Map<string, { revenue: number; deliveryRevenue: number; orders: number }>()
  if (buildDaily) {
    for (let i = 0; i < periodDays; i++) {
      const d = new Date(from)
      d.setDate(from.getDate() + i)
      const key = toMskDateString(d)
      dailyMap.set(key, { revenue: 0, deliveryRevenue: 0, orders: 0 })
    }
    // Раскладываем сервисную выручку по дням (join по МСК-ISO-дате).
    for (const dr of deliveryByDay) {
      const key = toMskDateString(dr.date)
      const day = dailyMap.get(key)
      if (day) day.deliveryRevenue += Number(dr.deliveryRevenue)
    }
  }

  let totalRevenue = 0
  let totalPortions = 0
  const clientMap = new Map<string, TopClient>()

  for (const o of orders) {
    const key = toMskDateString(o.deliveryDate)
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
  }

  const daily: DailyRevenuePoint[] = []
  if (buildDaily) {
    const useWeekdayLabel = periodDays <= 7 && isFinancialWeekRange(from, to)
    for (const [key, val] of dailyMap.entries()) {
      const d = new Date(key + 'T00:00:00')
      const dayLabel = useWeekdayLabel
        ? `${WEEKDAY_NAMES_SHORT_BY_DOW[d.getDay()]} ${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, '0')}`
        : `${d.getDate()} ${RU_MONTHS_SHORT[d.getMonth()]}`
      daily.push({ date: key, dayLabel, revenue: val.revenue, deliveryRevenue: val.deliveryRevenue, orders: val.orders })
    }
  }

  const topClients = Array.from(clientMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3)

  // WoW-сравнение. Прорейт: если today попадает в [from, to] — считаем
  // N = дней от from до today (вкл.). Иначе период закончен → N = periodDays.
  // Сравниваем sum(this[0..N-1]) с sum(prev[0..N-1]).
  // 7.46: prev = сдвиг РОВНО на −7 дней (одна неделя), а НЕ на −periodDays.
  // При week_to_date (Сб→сегодня) periodDays переменный; сдвиг −7 держит
  // сравнение выровненным по дням недели (тек. WTD vs те же дни прошлой недели).
  let wow: AdminDashboardData['wow'] = null
  if (opts.withWoW) {
    const today = startOfDay(new Date())
    const isOngoing = today >= startOfDay(from) && today <= endOfDay(to)
    const daysCompared = isOngoing
      ? Math.min(daysBetweenInclusive(from, today), periodDays)
      : periodDays
    const compareFrom = new Date(from)
    compareFrom.setDate(from.getDate() - 7)
    const compareTo = new Date(compareFrom)
    compareTo.setDate(compareFrom.getDate() + daysCompared - 1)
    compareTo.setHours(23, 59, 59, 999)
    const compareCutoff = new Date(from)
    compareCutoff.setDate(from.getDate() + daysCompared - 1)
    compareCutoff.setHours(23, 59, 59, 999)

    // Волна 4: сервисная выручка для обоих окон сравнения (food-логика WoW
    // не меняется — delivery считается рядом, отдельным полем).
    const [compareAgg, thisAggUpToCutoff, compareDelivery, thisDeliveryUpToCutoff] =
      await Promise.all([
        prisma.order.aggregate({
          where: {
            deliveryDate: { gte: compareFrom, lte: compareTo },
            status: { in: REVENUE_STATUSES },
          },
          _sum: { totalPrice: true },
        }),
        isOngoing
          ? prisma.order.aggregate({
              where: {
                deliveryDate: { gte: from, lte: compareCutoff },
                status: { in: REVENUE_STATUSES },
              },
              _sum: { totalPrice: true },
            })
          : Promise.resolve({ _sum: { totalPrice: totalRevenue } }),
        sumDeliveryRevenue({ from: compareFrom, to: compareTo }),
        isOngoing
          ? sumDeliveryRevenue({ from, to: compareCutoff })
          : Promise.resolve(deliveryTotal),
      ])

    const comparePrevRevenue = Number(compareAgg._sum.totalPrice ?? 0)
    const thisRevenueProrated = isOngoing
      ? Number(thisAggUpToCutoff._sum.totalPrice ?? 0)
      : totalRevenue

    const changePct = comparePrevRevenue > 0
      ? Math.round(((thisRevenueProrated - comparePrevRevenue) / comparePrevRevenue) * 1000) / 10
      : null

    wow = {
      changePct,
      comparePrevRevenue,
      prorated: isOngoing && daysCompared < periodDays,
      daysCompared,
      deliveryRevenue: Number(thisDeliveryUpToCutoff),
      comparePrevDeliveryRevenue: Number(compareDelivery),
    }
  }

  return {
    rangeFrom: from.toISOString(),
    rangeTo: to.toISOString(),
    thisPeriod: {
      totalRevenue,
      foodRevenue: totalRevenue,
      deliveryRevenue,
      grandTotalRevenue: totalRevenue + deliveryRevenue,
      totalOrders: orders.length,
      totalPortions,
      daily,
    },
    wow,
    topClients,
  }
}

export interface PeriodMargin {
  marginAbsolute: number
  marginPct: number | null
  /** Выручка по ЕДЕ — база маржи. Формула маржи food-only, не менялась. */
  totalRevenue: number
  totalCost: number
  /**
   * Сервисная выручка (доставка) за период. Волна 4: добавлено ОТДЕЛЬНЫМ полем
   * и НЕ участвует в расчёте marginAbsolute/marginPct (маржа считается по еде).
   */
  deliveryRevenue: number
}

/**
 * Маржа за период [from, to]: выручка − себестоимость сырья.
 *
 * Выручка и себестоимость считаются по ОДНОМУ набору статусов
 * (REVENUE_STATUSES) — getMaterialCostForRange принимает статусы параметром,
 * поэтому маржа не «съезжает» из-за рассинхрона выборок (тот же приём, что в
 * src/app/(app)/analytics/page.tsx).
 *
 * marginPct округляется до 0.1% (×1000/10). При нулевой выручке → null
 * (а не деление на ноль / ложный 0%); UI трактует null как «—».
 */
export async function getMarginForPeriod(from: Date, to: Date): Promise<PeriodMargin> {
  const [data, materialCost] = await Promise.all([
    getAdminDashboardData(from, to),
    getMaterialCostForRange(from, to, REVENUE_STATUSES),
  ])

  // Маржа — СТРОГО по еде: (foodRevenue − materialCost) / foodRevenue.
  // Доставка (data.thisPeriod.deliveryRevenue) НЕ входит в формулу.
  const totalRevenue = data.thisPeriod.totalRevenue
  const totalCost = materialCost.totalCost
  const marginAbsolute = totalRevenue - totalCost
  const marginPct =
    totalRevenue > 0 ? Math.round((marginAbsolute / totalRevenue) * 1000) / 10 : null

  return {
    marginAbsolute,
    marginPct,
    totalRevenue,
    totalCost,
    deliveryRevenue: data.thisPeriod.deliveryRevenue,
  }
}
