import {
  OrderStatus,
  type Prisma,
  type MealType,
  type PackagingType,
  type CourierAssignmentMode,
} from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import {
  resolveDeliveryContact,
  type DeliveryContactCandidate,
} from '@/lib/delivery/contact-resolver'
import { ensureCourierRouteStopsForDate } from '@/lib/delivery/route-materializer'
import { normalizeMskDeliveryDate } from '@/lib/delivery/route-domain'

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
export const COURIER_ASSIGNMENT_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.LOCKED,
  OrderStatus.IN_PRODUCTION,
  OrderStatus.OUT_FOR_DELIVERY,
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
  clientId: true,
  locationId: true,
  mealType: true,
  portions: true,
  totalPrice: true,
  client: {
    select: {
      name: true,
      contactName: true,
      contactPhone: true,
      contacts: {
        select: {
          id: true,
          clientId: true,
          locationId: true,
          isPrimaryForDelivery: true,
          name: true,
          phone: true,
          notes: true,
          sortOrder: true,
          createdAt: true,
        },
        orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
      },
    },
  },
  location: {
    select: {
      name: true,
      address: true,
      deliveryWindowFrom: true,
      deliveryWindowTo: true,
      assignedCourierId: true,
    },
  },
} satisfies Prisma.OrderSelect

type CourierQueryRow = {
  id: string
  clientId: string
  locationId: string
  mealType: MealType
  portions: number
  totalPrice: { toNumber: () => number }
  client: {
    name: string
    contactName: string | null
    contactPhone: string | null
    contacts: DeliveryContactCandidate[]
  }
  location: {
    name: string
    address: string
    deliveryWindowFrom: string | null
    deliveryWindowTo: string | null
    assignedCourierId: string | null
  }
}

function toDto(row: CourierQueryRow): OrderWithoutCourier {
  const contact = resolveDeliveryContact({
    clientId: row.clientId,
    locationId: row.locationId,
    contacts: row.client.contacts,
    legacy: {
      name: row.client.contactName,
      phone: row.client.contactPhone,
    },
  })

  return {
    orderId: row.id,
    clientName: row.client.name,
    clientContactPhone: contact?.phone ?? null,
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
  await ensureCourierRouteStopsForDate(tomorrowMsk)
  const rows = (await prisma.order.findMany({
    where: {
      deliveryDate: tomorrowMsk,
      status: { in: COURIER_ASSIGNMENT_STATUSES },
      courierMissingNotifiedAt: null,
      routeStop: {
        assignmentMode: { in: ['EXTERNAL', 'UNASSIGNED'] },
      },
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
  await ensureCourierRouteStopsForDate(todayMsk)
  const rows = (await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: { in: COURIER_ASSIGNMENT_STATUSES },
      courierMissingNotifiedAt: null,
      routeStop: {
        assignmentMode: { in: ['EXTERNAL', 'UNASSIGNED'] },
      },
      location: { deliveryWindowFrom: { not: null } },
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

export interface CourierAssignmentOrder {
  orderId: string
  clientId: string
  clientName: string
  clientContactName: string | null
  clientContactPhone: string | null
  locationId: string
  locationName: string
  locationAddress: string
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  mealType: MealType
  portions: number
  status: OrderStatus
  assignedCourierId: string | null
  assignedCourier: { id: string; name: string } | null
  assignmentMode: CourierAssignmentMode
  courierLabel: string
  packaging: PackagingType
  tags: string[]
  notes: string | null
}

const COURIER_ASSIGNMENT_SELECT = {
  id: true,
  clientId: true,
  locationId: true,
  mealType: true,
  portions: true,
  status: true,
  notes: true,
  location: {
    select: {
      packaging: true,
      tags: true,
    },
  },
  routeStop: {
    select: {
      assignmentMode: true,
      clientNameSnapshot: true,
      locationNameSnapshot: true,
      locationAddressSnapshot: true,
      contactNameSnapshot: true,
      contactPhoneSnapshot: true,
      deliveryWindowFromSnapshot: true,
      deliveryWindowToSnapshot: true,
      routeDay: {
        select: {
          courierId: true,
          courierNameSnapshot: true,
        },
      },
    },
  },
} satisfies Prisma.OrderSelect

type CourierAssignmentQueryRow = {
  id: string
  clientId: string
  locationId: string
  mealType: MealType
  portions: number
  status: OrderStatus
  notes: string | null
  location: {
    packaging: PackagingType
    tags: string[]
  }
  routeStop: {
    assignmentMode: CourierAssignmentMode
    clientNameSnapshot: string
    locationNameSnapshot: string
    locationAddressSnapshot: string
    contactNameSnapshot: string | null
    contactPhoneSnapshot: string | null
    deliveryWindowFromSnapshot: string | null
    deliveryWindowToSnapshot: string | null
    routeDay: {
      courierId: string
      courierNameSnapshot: string
    } | null
  } | null
}

/**
 * Общая read-only выборка распределения на точную @db.Date. Её используют
 * новый courier summary и HTML-лист сборки, чтобы назначение/контакт/status
 * не расходились между двумя представлениями.
 */
export async function getCourierAssignmentOrders(
  deliveryDate: Date,
): Promise<CourierAssignmentOrder[]> {
  const exactDeliveryDate = normalizeMskDeliveryDate(deliveryDate)
  await ensureCourierRouteStopsForDate(exactDeliveryDate)
  const rows = (await prisma.order.findMany({
    where: {
      deliveryDate: exactDeliveryDate,
      status: { in: COURIER_ASSIGNMENT_STATUSES },
    },
    select: COURIER_ASSIGNMENT_SELECT,
  })) as unknown as CourierAssignmentQueryRow[]

  return rows.map((row) => {
    const stop = row.routeStop
    if (!stop) {
      throw new Error(`Order ${row.id} has no route stop after materialization`)
    }
    const assignedCourier =
      stop.assignmentMode === 'IN_HOUSE' && stop.routeDay
        ? {
            id: stop.routeDay.courierId,
            name: stop.routeDay.courierNameSnapshot,
          }
        : null
    const courierLabel = assignedCourier?.name ?? (
      stop.assignmentMode === 'EXTERNAL' ? 'InDrive' : 'Не назначено'
    )

    return {
      orderId: row.id,
      clientId: row.clientId,
      clientName: stop.clientNameSnapshot,
      clientContactName: stop.contactNameSnapshot,
      clientContactPhone: stop.contactPhoneSnapshot,
      locationId: row.locationId,
      locationName: stop.locationNameSnapshot,
      locationAddress: stop.locationAddressSnapshot,
      deliveryWindowFrom: stop.deliveryWindowFromSnapshot,
      deliveryWindowTo: stop.deliveryWindowToSnapshot,
      mealType: row.mealType,
      portions: row.portions,
      status: row.status,
      assignedCourierId: assignedCourier?.id ?? null,
      assignedCourier,
      assignmentMode: stop.assignmentMode,
      courierLabel,
      packaging: row.location.packaging,
      tags: row.location.tags,
      notes: row.notes,
    }
  })
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
