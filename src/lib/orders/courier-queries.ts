import { OrderStatus, type MealType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'

/**
 * П5: выборки заказов БЕЗ назначенного курьера для cron'ов
 * courier-evening-preview (вечерний обзор на завтра) и
 * courier-hour-before-window (за час до окна доставки сегодня).
 *
 * Курьер привязывается к ТОЧКЕ (ClientLocation.assignedCourierId), а не к
 * заказу. «Без курьера» = order.location.assignedCourierId === null.
 *
 * Антидубль — Order.courierMissingNotifiedAt (один флаг на оба cron'а):
 * заказ, по которому уже уведомили, в выборку не попадает.
 */

const MSK_OFFSET_HOURS = 3

/** Статусы, при которых заказ реально поедет и курьер обязателен. */
const ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.LOCKED,
  OrderStatus.IN_PRODUCTION,
]

/** За час до окна берём заказы, чьё начало окна попадает в [now+50м, now+90м]. */
const WINDOW_LEAD_MIN_MINUTES = 50
const WINDOW_LEAD_MAX_MINUTES = 90

export interface OrderWithoutCourier {
  orderId: string
  clientName: string
  clientContactPhone: string | null
  locationName: string
  locationAddress: string
  deliveryWindowFrom: string | null // "HH:mm" или null
  deliveryWindowTo: string | null
  mealType: MealType
  portions: number
  totalPrice: number
}

/** Общий include для обеих выборок — поля клиента и точки. */
const COURIER_QUERY_SELECT = {
  id: true,
  mealType: true,
  portions: true,
  totalPrice: true,
  client: { select: { name: true, contactPhone: true } },
  location: {
    select: {
      name: true,
      address: true,
      deliveryWindowFrom: true,
      deliveryWindowTo: true,
      assignedCourierId: true,
    },
  },
} as const

type CourierQueryRow = {
  id: string
  mealType: MealType
  portions: number
  totalPrice: { toNumber: () => number }
  client: { name: string; contactPhone: string | null }
  location: {
    name: string
    address: string
    deliveryWindowFrom: string | null
    deliveryWindowTo: string | null
    assignedCourierId: string | null
  }
}

function toDto(row: CourierQueryRow): OrderWithoutCourier {
  return {
    orderId: row.id,
    clientName: row.client.name,
    clientContactPhone: row.client.contactPhone,
    locationName: row.location.name,
    locationAddress: row.location.address,
    deliveryWindowFrom: row.location.deliveryWindowFrom,
    deliveryWindowTo: row.location.deliveryWindowTo,
    mealType: row.mealType,
    portions: row.portions,
    // totalPrice — Prisma.Decimal → Number.
    totalPrice: row.totalPrice.toNumber(),
  }
}

/**
 * Заказы на ЗАВТРА (МСК) без курьера, по которым ещё не уведомляли.
 * Включает заказы с deliveryWindowFrom=null (вечерний обзор покажет
 * «окно не указано»). Сортировка — на стороне route.
 */
export async function getOrdersWithoutCourierTomorrow(): Promise<OrderWithoutCourier[]> {
  const tomorrowMsk = mskMidnightUtc(new Date(), 1)
  const rows = (await prisma.order.findMany({
    where: {
      deliveryDate: tomorrowMsk,
      status: { in: ACTIVE_STATUSES },
      courierMissingNotifiedAt: null,
      location: { assignedCourierId: null },
    },
    select: COURIER_QUERY_SELECT,
  })) as unknown as CourierQueryRow[]

  return rows.map(toDto)
}

/**
 * Заказы на СЕГОДНЯ (МСК) без курьера, начало окна которых наступает примерно
 * через час: windowStart ∈ [now+50м, now+90м] (буфер на запоздалый cron при
 * расписании каждые 30 мин). Только location.deliveryWindowFrom !== null —
 * без окна посчитать «через час» нельзя.
 */
export async function getOrdersForHourBeforeWindow(now: Date): Promise<OrderWithoutCourier[]> {
  const todayMsk = mskMidnightUtc(now, 0)
  const rows = (await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: { in: ACTIVE_STATUSES },
      courierMissingNotifiedAt: null,
      location: { assignedCourierId: null, deliveryWindowFrom: { not: null } },
    },
    select: COURIER_QUERY_SELECT,
  })) as unknown as CourierQueryRow[]

  const lowerMs = now.getTime() + WINDOW_LEAD_MIN_MINUTES * 60_000
  const upperMs = now.getTime() + WINDOW_LEAD_MAX_MINUTES * 60_000

  return rows
    .filter((row) => {
      const windowStart = windowStartUtc(row.location.deliveryWindowFrom, todayMsk)
      if (windowStart === null) return false
      const t = windowStart.getTime()
      return t >= lowerMs && t <= upperMs
    })
    .map(toDto)
}

/**
 * Помечает заказы как «уведомлены об отсутствии курьера». Условие
 * courierMissingNotifiedAt:null в where — защита от гонки между двумя
 * параллельными запусками. Возвращает фактически обновлённый count.
 */
export async function markCourierNotified(orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0
  const result = await prisma.order.updateMany({
    where: { id: { in: orderIds }, courierMissingNotifiedAt: null },
    data: { courierMissingNotifiedAt: new Date() },
  })
  return result.count
}

/**
 * Момент начала окна доставки в UTC: "HH:mm" МСК на дату todayMsk.
 * todayMsk — UTC-полночь МСК-даты, окно «HH:mm МСК» = (HH-3):mm UTC
 * (тот же подход, что в check-late-deliveries). null при некорректном формате.
 */
function windowStartUtc(windowFromHHmm: string | null, todayMsk: Date): Date | null {
  if (!windowFromHHmm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(windowFromHHmm)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const windowStart = new Date(todayMsk)
  windowStart.setUTCHours(hours - MSK_OFFSET_HOURS, minutes, 0, 0)
  return windowStart
}
