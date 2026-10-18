import { prisma } from '@/lib/db/prisma'
import { getFinancialWeekForDbDate, toDbDateRange, countDbDays } from '@/lib/utils/week'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
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

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * true, если МСК-дни [range.gte, range.lt) — ровно финансовая неделя Сб→Пт.
 * Сравниваем UTC-полночи (@db.Date-семантика), без серверного setHours.
 */
function isFinancialWeekRange(range: { gte: Date; lt: Date }): boolean {
  const week = getFinancialWeekForDbDate(range.gte)
  const fw = toDbDateRange(week.from, week.to)
  return range.gte.getTime() === fw.gte.getTime() && range.lt.getTime() === fw.lt.getTime()
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
  // Дефолт: текущая финансовая неделя (toDbDateRange ниже нормализует к МСК-дням).
  const { from: defaultFrom, to: defaultTo } = getFinancialWeekForDbDate(new Date())
  const from = rangeFrom ?? defaultFrom
  const to = rangeTo ?? defaultTo

  // КОНТРАКТ: [from, to] — ВКЛЮЧИТЕЛЬНЫЙ диапазон МСК-дней (from/to — UTC-полночь
  // дня, МСК-инстант полуночи или момент внутри МСК-дня, см. toDbDateRange).
  // В @db.Date-фильтры идут UTC-полночи { gte: первый день, lt: день после
  // последнего }; в delivery-revenue (half-open [from, to)) — те же gte/lt.
  // Раньше: delivery получал endOfDay(to) с `lt` → последний день терялся
  // («Сегодня» — доставка 0), а МСК-инстант from втягивал лишний день.
  const range = toDbDateRange(from, to)

  // Волна 4: сервисная выручка (доставка). Запрашиваем параллельно. Хелпер
  // дедупит fee один раз на (локация, день) и игнорит null-fee. Маржа на эти
  // цифры НЕ опирается — это отдельный «сервисный» поток.
  const [orders, deliveryTotal, deliveryByDay] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: range.gte, lt: range.lt },
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
    sumDeliveryRevenue({ from: range.gte, to: range.lt }),
    deliveryRevenueByDay({ from: range.gte, to: range.lt }),
  ])

  const deliveryRevenue = Number(deliveryTotal)

  // daily — только для коротких диапазонов
  const periodDays = countDbDays(range)
  const buildDaily = periodDays <= MAX_DAILY_POINTS

  // Ключ дня = 'YYYY-MM-DD' UTC-полночи (@db.Date deliveryDate хранится так же).
  const dayKey = (d: Date) => d.toISOString().slice(0, 10)
  const dailyMap = new Map<string, { revenue: number; deliveryRevenue: number; orders: number }>()
  if (buildDaily) {
    for (let i = 0; i < periodDays; i++) {
      const d = new Date(range.gte.getTime() + i * DAY_MS)
      dailyMap.set(dayKey(d), { revenue: 0, deliveryRevenue: 0, orders: 0 })
    }
    // Раскладываем сервисную выручку по дням (join по дате).
    for (const dr of deliveryByDay) {
      const day = dailyMap.get(dayKey(dr.date))
      if (day) day.deliveryRevenue += Number(dr.deliveryRevenue)
    }
  }

  let totalRevenue = 0
  let totalPortions = 0
  const clientMap = new Map<string, TopClient>()

  for (const o of orders) {
    const day = dailyMap.get(dayKey(o.deliveryDate))
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
    const useWeekdayLabel = periodDays <= 7 && isFinancialWeekRange(range)
    for (const [key, val] of dailyMap.entries()) {
      // UTC-полночь дня → UTC-компоненты (TZ процесса не влияет).
      const d = new Date(key + 'T00:00:00.000Z')
      const dayLabel = useWeekdayLabel
        ? `${WEEKDAY_NAMES_SHORT_BY_DOW[d.getUTCDay()]} ${d.getUTCDate()}.${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`
        : `${d.getUTCDate()} ${RU_MONTHS_SHORT[d.getUTCMonth()]}`
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
  // Все окна — half-open UTC-полночи МСК-дней (today — МСК-сегодня, а не
  // серверный UTC setHours: в 00:00–03:00 МСК тот был «вчера»).
  let wow: AdminDashboardData['wow'] = null
  if (opts.withWoW) {
    const today = getMskCalendarDayUtc(new Date(), 0)
    const isOngoing = today.getTime() >= range.gte.getTime() && today.getTime() < range.lt.getTime()
    const daysCompared = isOngoing
      ? Math.min(Math.round((today.getTime() - range.gte.getTime()) / DAY_MS) + 1, periodDays)
      : periodDays
    const compareFrom = new Date(range.gte.getTime() - 7 * DAY_MS)
    const compareToExcl = new Date(compareFrom.getTime() + daysCompared * DAY_MS)
    const cutoffExcl = new Date(range.gte.getTime() + daysCompared * DAY_MS)

    // Волна 4: сервисная выручка для обоих окон сравнения (food-логика WoW
    // не меняется — delivery считается рядом, отдельным полем).
    const [compareAgg, thisAggUpToCutoff, compareDelivery, thisDeliveryUpToCutoff] =
      await Promise.all([
        prisma.order.aggregate({
          where: {
            deliveryDate: { gte: compareFrom, lt: compareToExcl },
            status: { in: REVENUE_STATUSES },
          },
          _sum: { totalPrice: true },
        }),
        isOngoing
          ? prisma.order.aggregate({
              where: {
                deliveryDate: { gte: range.gte, lt: cutoffExcl },
                status: { in: REVENUE_STATUSES },
              },
              _sum: { totalPrice: true },
            })
          : Promise.resolve({ _sum: { totalPrice: totalRevenue } }),
        sumDeliveryRevenue({ from: compareFrom, to: compareToExcl }),
        isOngoing
          ? sumDeliveryRevenue({ from: range.gte, to: cutoffExcl })
          : Promise.resolve(deliveryTotal),
      ])

    const comparePrevRevenue = Number(compareAgg._sum.totalPrice ?? 0)
    const thisRevenueProrated = isOngoing
      ? Number(thisAggUpToCutoff._sum.totalPrice ?? 0)
      : totalRevenue

    // Волна 1: дельта по ОБЩЕЙ выручке (еда + доставка) — как и главная цифра
    // дашборда. Доставка берётся симметрично для обоих окон (this/prev).
    const thisGrandProrated = thisRevenueProrated + Number(thisDeliveryUpToCutoff)
    const comparePrevGrand = comparePrevRevenue + Number(compareDelivery)
    const changePct = comparePrevGrand > 0
      ? Math.round(((thisGrandProrated - comparePrevGrand) / comparePrevGrand) * 1000) / 10
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
