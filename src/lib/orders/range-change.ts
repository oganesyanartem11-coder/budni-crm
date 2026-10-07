import type { MealType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  IN_WORK_STATUSES,
  isDeliveryDateEditable,
  setOrderPortionsForClient,
  type Actor,
} from '@/lib/orders/client-portions'
import { MEAL_TYPE_RU } from '@/lib/boris/labels'
import { formatWeeklyDate, parseItemDate } from '@/lib/weekly/sanity-checks'

/**
 * Изменение заказов клиента на несколько дней сразу: «с 7 по 14 +1 обед»,
 * «всю неделю по 30». Общий путь для запроса клиента (бот → менеджер
 * подтверждает) и для Бориса (менеджер → кнопка «Подтвердить»).
 *
 * Меняются только УЖЕ существующие заказы (FIXED/DYNAMIC/STICKY генерируются
 * заранее, WEEKLY — по заявке): выходные и дни без доставки сами собой не
 * получат заказ. План фиксирует «было» по каждому заказу; при применении,
 * если заказ с тех пор поменяли, строка пропускается — повторное нажатие
 * не прибавит второй раз.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_RANGE_DAYS = 31

export interface RangeChangeRequest {
  clientId: string
  /** null — все точки клиента. */
  locationId: string | null
  /** null/пусто — все приёмы пищи. */
  mealTypes: MealType[] | null
  dateFrom: string // YYYY-MM-DD
  dateTo: string // YYYY-MM-DD, включительно
  /** add — portions это изменение со знаком; set — итог на день. */
  mode: 'set' | 'add'
  portions: number
  /** ISO-дни недели 1..7 (пн..вс); пусто — все дни. */
  weekdays?: number[] | null
}

export interface RangeLine {
  orderId: string
  date: string
  locationId: string
  locationName: string
  mealType: MealType
  /** Порции на момент плана — при применении заказ должен быть таким же. */
  expected: number
  next: number
}

export interface RangeSkip {
  date: string
  locationName: string
  mealType: MealType
  reason: string
}

export interface RangePlan {
  lines: RangeLine[]
  skipped: RangeSkip[]
  /** Дни периода, на которые у клиента нет ни одного подходящего заказа. */
  missingDates: string[]
}

function isoWeekday(day: Date): number {
  return day.getUTCDay() === 0 ? 7 : day.getUTCDay()
}

/** Проверка входа: даты, порядок, длина периода. null — всё ок. */
export function validateRangeRequest(req: RangeChangeRequest): string | null {
  const from = parseItemDate(req.dateFrom)
  const to = parseItemDate(req.dateTo)
  if (!from || !to) return 'Даты в формате YYYY-MM-DD'
  if (to.getTime() < from.getTime()) return 'Конец периода раньше начала'
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return `Период длиннее ${MAX_RANGE_DAYS} дней`
  }
  if (!Number.isInteger(req.portions)) return 'Количество — целое число'
  if (req.mode === 'add' ? req.portions === 0 : req.portions < 0) return 'Непонятное количество'
  return null
}

export async function planRangeChange(req: RangeChangeRequest, now: Date = new Date()): Promise<RangePlan> {
  const from = parseItemDate(req.dateFrom)!
  const to = parseItemDate(req.dateTo)!
  const weekdays = req.weekdays && req.weekdays.length > 0 ? new Set(req.weekdays) : null

  const orders = await prisma.order.findMany({
    where: {
      clientId: req.clientId,
      deliveryDate: { gte: from, lte: to },
      status: { not: 'CANCELLED' },
      ...(req.locationId ? { locationId: req.locationId } : {}),
      ...(req.mealTypes && req.mealTypes.length > 0 ? { mealType: { in: req.mealTypes } } : {}),
    },
    select: {
      id: true,
      deliveryDate: true,
      mealType: true,
      portions: true,
      status: true,
      locationId: true,
      updDocumentLink: { select: { id: true } },
      location: {
        select: { name: true, sameDayDelivery: true, isActive: true, cutoffHourMsk: true, cutoffMinuteMsk: true },
      },
    },
    orderBy: [{ deliveryDate: 'asc' }, { mealType: 'asc' }],
  })

  const lines: RangeLine[] = []
  const skipped: RangeSkip[] = []
  const datesWithOrders = new Set<string>()

  for (const o of orders) {
    if (weekdays && !weekdays.has(isoWeekday(o.deliveryDate))) continue
    const date = o.deliveryDate.toISOString().slice(0, 10)
    datesWithOrders.add(date)
    const base = { date, locationName: o.location.name, mealType: o.mealType }

    if (IN_WORK_STATUSES.has(o.status)) {
      skipped.push({ ...base, reason: 'уже в работе у кухни' })
      continue
    }
    if (o.updDocumentLink) {
      skipped.push({ ...base, reason: 'по заказу выписан УПД' })
      continue
    }
    if (!isDeliveryDateEditable(o.location, o.deliveryDate, now)) {
      skipped.push({ ...base, reason: 'приём на эту дату уже закрыт' })
      continue
    }
    const unanswered = o.portions === 0 && (o.status === 'PENDING_CONFIRMATION' || o.status === 'DRAFT')
    if (req.mode === 'add' && unanswered) {
      skipped.push({ ...base, reason: 'клиент ещё не назвал число — не к чему прибавить' })
      continue
    }
    const next = req.mode === 'add' ? o.portions + req.portions : req.portions
    if (next < 0) {
      skipped.push({ ...base, reason: `в заказе ${o.portions}, убрать ${-req.portions} нельзя` })
      continue
    }
    if (next === o.portions && o.status === 'CONFIRMED') {
      skipped.push({ ...base, reason: `уже ${next}` })
      continue
    }
    lines.push({
      orderId: o.id,
      date,
      locationId: o.locationId,
      locationName: o.location.name,
      mealType: o.mealType,
      expected: o.portions,
      next,
    })
  }

  const missingDates: string[] = []
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const day = new Date(t)
    if (weekdays && !weekdays.has(isoWeekday(day))) continue
    const date = day.toISOString().slice(0, 10)
    if (!datesWithOrders.has(date)) missingDates.push(date)
  }

  return { lines, skipped, missingDates }
}

export interface RangeLineResult {
  ok: boolean
  note: string | null
}

/**
 * Применяет строку плана. Заказ с тех пор изменили (не «было» и не «стало»)
 * — пропуск: второй клик/второй менеджер не прибавит ещё раз.
 */
export async function applyRangeLine(
  actor: Actor,
  line: Pick<RangeLine, 'orderId' | 'expected' | 'next'>,
  via: string,
  now: Date = new Date(),
): Promise<RangeLineResult> {
  const order = await prisma.order.findUnique({
    where: { id: line.orderId },
    select: {
      portions: true,
      status: true,
      deliveryDate: true,
      location: { select: { sameDayDelivery: true, isActive: true, cutoffHourMsk: true, cutoffMinuteMsk: true } },
    },
  })
  if (!order || order.status === 'CANCELLED') return { ok: false, note: 'заказ отменён' }
  if (order.portions === line.next && order.status === 'CONFIRMED') return { ok: true, note: 'уже стоит' }
  if (order.portions !== line.expected) {
    return { ok: false, note: `заказ изменился, сейчас ${order.portions}` }
  }
  if (!isDeliveryDateEditable(order.location, order.deliveryDate, now)) {
    return { ok: false, note: 'приём на эту дату уже закрыт' }
  }
  const r = await setOrderPortionsForClient(actor, { orderId: line.orderId, portions: line.next, via })
  if (r.ok) return { ok: true, note: null }
  return { ok: false, note: r.skipped ? r.reason : r.error }
}

/** «чт 8 окт, обед» (+ точка, если их несколько). */
export function rangeLineLabel(
  l: { date: string; mealType: MealType; locationName: string },
  multiLocation: boolean,
): string {
  const parts = [formatWeeklyDate(l.date), MEAL_TYPE_RU[l.mealType]]
  if (multiLocation) parts.push(l.locationName)
  return parts.join(', ')
}

export function isMultiLocationPlan(plan: Pick<RangePlan, 'lines' | 'skipped'>): boolean {
  return new Set([...plan.lines, ...plan.skipped].map((l) => l.locationName)).size > 1
}

/** Что было запрошено: «+1», «−2», «по 30». */
export function formatRangeAmount(mode: 'set' | 'add', portions: number): string {
  if (mode === 'set') return `по ${portions}`
  return portions > 0 ? `+${portions}` : `−${-portions}`
}

/** Строки плана для сообщения (plain text, без HTML). */
export function formatRangePlanLines(plan: RangePlan): string[] {
  const multi = isMultiLocationPlan(plan)
  const rows = plan.lines.map((l) => `• ${rangeLineLabel(l, multi)} — ${l.expected} → ${l.next}`)
  if (plan.skipped.length > 0) {
    rows.push('Не изменится:')
    for (const s of plan.skipped) rows.push(`• ${rangeLineLabel(s, multi)} — ${s.reason}`)
  }
  if (plan.missingDates.length > 0) {
    rows.push(`Заказов нет: ${plan.missingDates.map(formatWeeklyDate).join(', ')}`)
  }
  return rows
}

