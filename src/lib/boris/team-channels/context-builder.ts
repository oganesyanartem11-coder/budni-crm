/**
 * Сборщики контекста для Командного Бориса (Спринт 7.16.C, ЭТАП 1).
 *
 * Здесь только чистый сбор фактажа из БД — никаких AI-вызовов и решений
 * «писать или молчать». Эти функции дают AI-formatter'у сырые цифры,
 * а решение остаётся за моделью.
 *
 * buildDayContext  — для каналов LIVE / EVENING.
 * buildWeekContext — для канала FRIDAY (финансовая неделя Сб-Пт).
 *
 * Триггеры событий, cron-роуты, AI-вызовы — следующие этапы.
 */

import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { ACTIVE_ORDER_STATUSES } from '@/lib/constants/order'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import { sumDeliveryRevenue } from '@/lib/db/queries/delivery-revenue'
import { getFinancialWeek, getPreviousFinancialWeek } from '@/lib/utils/week'
import type {
  ClientOrderAggregate,
  DayContext,
  ToneSummary,
  WeekContext,
} from './types'

// «Реальный» сегодня: всё что было в работе хотя бы в одной стадии, плюс уже
// доставленные. CANCELLED/DRAFT/PENDING_CONFIRMATION на дне не считаем —
// та же семантика что в end-of-day-digest (заменяемый этим модулем).
const TODAY_STATUSES: OrderStatus[] = [...ACTIVE_ORDER_STATUSES, 'DELIVERED']

const ORDINARY_DAY_BAND = 0.1 // ±10% от средней недели → день «обычный»
const DAY_MS = 24 * 60 * 60 * 1000

function aggregateByClient(
  orders: Array<{ clientId: string; portions: number; client: { name: string } }>,
): ClientOrderAggregate[] {
  const map = new Map<string, ClientOrderAggregate>()
  for (const o of orders) {
    const prev = map.get(o.clientId)
    if (prev) prev.portions += o.portions
    else map.set(o.clientId, { clientId: o.clientId, clientName: o.client.name, portions: o.portions })
  }
  return Array.from(map.values()).sort((a, b) => b.portions - a.portions)
}

async function getPortionsTotalForDeliveryDate(deliveryDate: Date, statuses: OrderStatus[]): Promise<number> {
  const agg = await prisma.order.aggregate({
    where: { deliveryDate, status: { in: statuses } },
    _sum: { portions: true },
  })
  return agg._sum.portions ?? 0
}

async function getToneSummary(from: Date, to: Date): Promise<ToneSummary> {
  const rows = await prisma.clientAlertLog.groupBy({
    by: ['tone'],
    where: { createdAt: { gte: from, lte: to } },
    _count: { _all: true },
  })
  const result: ToneSummary = { thanks: 0, rude: 0, urgent: 0 }
  for (const r of rows) {
    if (r.tone === 'rude') result.rude = r._count._all
    else if (r.tone === 'urgent') result.urgent = r._count._all
    // tone=null = просто signal без эмоции, в саммари не несём.
  }
  // «Спасибо» считается через InboxItemReason='THANKS' — Sprint 7.15.B пишет
  // их в ClientAlertLog.reason, а не tone. Сводим по reason отдельно.
  const thanks = await prisma.clientAlertLog.count({
    where: { createdAt: { gte: from, lte: to }, reason: 'THANKS' },
  })
  result.thanks = thanks
  return result
}

/**
 * Собирает контекст одного МСК-дня для каналов LIVE / EVENING.
 *
 * `now` интерпретируется как «сейчас» — определяет МСК-сутки. Для cron'а в
 * 20:00 МСК передавать new Date(); для админских триггеров и тестов — явный.
 */
export async function buildDayContext(now: Date = new Date()): Promise<DayContext> {
  const todayMsk = mskMidnightUtc(now, 0)
  const tomorrowMsk = mskMidnightUtc(now, 1)

  // 7.16.C.3: окно тонов = СТРОГО сегодняшние МСК-сутки. Раньше было 48ч,
  // из-за чего EVENING в 20:00 включал вчерашние реакции и Боря писал
  // «на фоне 4 грубых тонов за день», хотя грубости были вчера. EVENING
  // должен говорить только про факты текущего дня.
  const [todayAgg, todayOrders, tomorrowOrders, materialCostToday, events, tones, deliveryToday] =
    await Promise.all([
      prisma.order.aggregate({
        where: { deliveryDate: todayMsk, status: { in: TODAY_STATUSES } },
        _sum: { totalPrice: true, portions: true },
      }),
      prisma.order.findMany({
        where: { deliveryDate: todayMsk, status: { in: TODAY_STATUSES } },
        select: { portions: true, clientId: true, client: { select: { name: true } } },
      }),
      prisma.order.findMany({
        where: { deliveryDate: tomorrowMsk, status: { in: ACTIVE_ORDER_STATUSES } },
        select: {
          portions: true,
          clientId: true,
          status: true,
          client: { select: { name: true } },
        },
      }),
      getMaterialCostForRange(todayMsk, todayMsk, TODAY_STATUSES),
      prisma.borisEventLog.findMany({
        where: { eventDate: { gte: todayMsk, lt: tomorrowMsk } },
        orderBy: { createdAt: 'asc' },
      }),
      getToneSummary(todayMsk, tomorrowMsk),
      // Волна 4: сервисная выручка (доставка) за сегодня — отдельно от food.
      sumDeliveryRevenue({ from: todayMsk, to: tomorrowMsk }),
    ])

  const portionsToday = todayAgg._sum.portions ?? 0
  const revenueToday = Number(todayAgg._sum.totalPrice ?? 0)
  const deliveryRevenueToday = Number(deliveryToday)

  const tomorrowByClient = aggregateByClient(tomorrowOrders)
  const portionsTomorrow = tomorrowOrders.reduce((s, o) => s + o.portions, 0)
  const pendingTomorrow = tomorrowOrders.filter((o) => o.status === 'PENDING_CONFIRMATION').length

  // Средняя по 4 предыдущим неделям на ту же weekday (день - 7, - 14, - 21, - 28).
  // Финансовая неделя тут не нужна — мы сравниваем тот же weekday, неделя как
  // календарный период. Если за все 4 недели не было ни одного заказа, считаем
  // что базы для сравнения нет и помечаем isOrdinaryDay=false.
  const prevWeekdayPortions = await Promise.all(
    [1, 2, 3, 4].map((w) =>
      getPortionsTotalForDeliveryDate(new Date(todayMsk.getTime() - w * 7 * DAY_MS), TODAY_STATUSES),
    ),
  )
  const nonZeroSamples = prevWeekdayPortions.filter((p) => p > 0)
  const fourWeekAveragePortions =
    nonZeroSamples.length === 0 ? null : nonZeroSamples.reduce((s, p) => s + p, 0) / nonZeroSamples.length
  const maxPrevWeekday = prevWeekdayPortions.length === 0 ? 0 : Math.max(...prevWeekdayPortions)

  const isRecordDay = portionsToday > 0 && portionsToday > maxPrevWeekday

  let isOrdinaryDay = false
  if (
    fourWeekAveragePortions !== null &&
    !isRecordDay &&
    tones.thanks === 0 &&
    tones.rude === 0 &&
    tones.urgent === 0 &&
    events.length === 0
  ) {
    const lower = fourWeekAveragePortions * (1 - ORDINARY_DAY_BAND)
    const upper = fourWeekAveragePortions * (1 + ORDINARY_DAY_BAND)
    isOrdinaryDay = portionsToday >= lower && portionsToday <= upper
  }

  return {
    date: todayMsk,
    today: {
      portionsTotal: portionsToday,
      revenueRub: revenueToday,
      foodRevenueRub: revenueToday,
      deliveryRevenueRub: deliveryRevenueToday,
      totalRevenueRub: revenueToday + deliveryRevenueToday,
      materialCostRub: materialCostToday.totalCost,
      daysWithoutMenu: materialCostToday.daysWithoutMenu,
      byClient: aggregateByClient(todayOrders),
    },
    tomorrow: {
      portionsTotal: portionsTomorrow,
      pendingConfirmation: pendingTomorrow,
      byClient: tomorrowByClient,
    },
    events,
    tones,
    fourWeekAveragePortions,
    isOrdinaryDay,
    isRecordDay,
  }
}

/**
 * Собирает контекст финансовой недели (Сб-Пт) для канала FRIDAY.
 *
 * `now` обычно = пятничный полдень — getFinancialWeek даст текущую Сб-Пт.
 * Параллельная неделя минус 1 нужна для сравнения «лучше/хуже прошлой».
 */
export async function buildWeekContext(now: Date = new Date()): Promise<WeekContext> {
  const { from: weekFrom, to: weekTo } = getFinancialWeek(now)
  const { from: prevFrom, to: prevTo } = getPreviousFinancialWeek(now)

  // Для запросов по @db.Date Order.deliveryDate границы должны быть МСК-полуночами;
  // getFinancialWeek уже возвращает корректные MSK-полночи как UTC-точки.
  // Волна 4: верхняя граница для delivery-хелпера полу-открытая [from, to) —
  // прибавляем сутки к weekTo (МСК-полночь последнего дня), чтобы включить его.
  const weekToExclusive = new Date(weekTo.getTime() + DAY_MS)

  const [weekAgg, weekOrders, prevWeekAgg, materialCostWeek, events, tones, deliveryWeek] =
    await Promise.all([
    prisma.order.aggregate({
      where: { deliveryDate: { gte: weekFrom, lte: weekTo }, status: { in: TODAY_STATUSES } },
      _sum: { totalPrice: true, portions: true },
      _count: { _all: true },
    }),
    prisma.order.findMany({
      where: { deliveryDate: { gte: weekFrom, lte: weekTo }, status: { in: TODAY_STATUSES } },
      select: {
        portions: true,
        clientId: true,
        deliveryDate: true,
        client: { select: { name: true } },
      },
    }),
    prisma.order.aggregate({
      where: { deliveryDate: { gte: prevFrom, lte: prevTo }, status: { in: TODAY_STATUSES } },
      _sum: { totalPrice: true, portions: true },
    }),
    getMaterialCostForRange(weekFrom, weekTo, TODAY_STATUSES),
    prisma.borisEventLog.findMany({
      where: { eventDate: { gte: weekFrom, lte: weekTo } },
      orderBy: { createdAt: 'asc' },
    }),
    getToneSummary(weekFrom, weekTo),
    // Волна 4: сервисная выручка (доставка) за неделю — отдельно от food.
    sumDeliveryRevenue({ from: weekFrom, to: weekToExclusive }),
  ])

  const weekRevenueRub = Number(weekAgg._sum.totalPrice ?? 0)
  const deliveryRevenueWeek = Number(deliveryWeek)

  const byClientAgg = aggregateByClient(weekOrders)
  const topClients = byClientAgg.slice(0, 5)

  // Пиковый день: max портций; tie-break — раньше по дате.
  const byDay = new Map<string, { date: Date; portions: number }>()
  for (const o of weekOrders) {
    const iso = o.deliveryDate.toISOString().slice(0, 10)
    const cur = byDay.get(iso)
    if (cur) cur.portions += o.portions
    else byDay.set(iso, { date: o.deliveryDate, portions: o.portions })
  }
  const peakDay =
    Array.from(byDay.values()).sort((a, b) => {
      if (b.portions !== a.portions) return b.portions - a.portions
      return a.date.getTime() - b.date.getTime()
    })[0] ?? null

  // Новые клиенты на этой неделе: те, у кого САМАЯ РАННЯ доставка попадает в [weekFrom, weekTo].
  // Считаем по REVENUE-семантике (TODAY_STATUSES совпадает с REVENUE_STATUSES из старого
  // friday-week-digest в части ACTIVE+DELIVERED — CANCELLED/DRAFT не считаются за «отгрузку»).
  const candidateClientIds = byClientAgg.map((c) => c.clientId)
  const earliestPerClient = await Promise.all(
    candidateClientIds.map(async (clientId) => {
      const earliest = await prisma.order.findFirst({
        where: { clientId, status: { in: TODAY_STATUSES } },
        orderBy: { deliveryDate: 'asc' },
        select: { deliveryDate: true },
      })
      return { clientId, earliest: earliest?.deliveryDate ?? null }
    }),
  )
  const newClientIds = new Set(
    earliestPerClient
      .filter((x) => x.earliest && x.earliest >= weekFrom && x.earliest <= weekTo)
      .map((x) => x.clientId),
  )
  const newClients = byClientAgg.filter((c) => newClientIds.has(c.clientId))

  return {
    weekFrom,
    weekTo,
    portionsTotal: weekAgg._sum.portions ?? 0,
    revenueRub: weekRevenueRub,
    foodRevenueRub: weekRevenueRub,
    deliveryRevenueRub: deliveryRevenueWeek,
    totalRevenueRub: weekRevenueRub + deliveryRevenueWeek,
    materialCostRub: materialCostWeek.totalCost,
    daysWithoutMenu: materialCostWeek.daysWithoutMenu,
    ordersCount: weekAgg._count._all,
    topClients,
    peakDay,
    newClients,
    events,
    tones,
    prevWeekPortionsTotal: prevWeekAgg._sum.portions ?? 0,
    prevWeekRevenueRub: Number(prevWeekAgg._sum.totalPrice ?? 0),
  }
}
