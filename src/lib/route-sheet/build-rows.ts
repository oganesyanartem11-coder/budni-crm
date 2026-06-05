import { prisma } from '@/lib/db/prisma'
import type { MealType, OrderStatus, PackagingType } from '@prisma/client'

/** Статусы заказа, попадающие в маршрутный лист (вечерний/основной режим). */
const ROUTE_SHEET_STATUSES: OrderStatus[] = ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION']

/** Same-day режим: только подтверждённые (ещё не залоченные/в производстве). */
const SAME_DAY_STATUSES: OrderStatus[] = ['CONFIRMED']

export interface RouteSheetRow {
  /** Порядковый номер в листе (1-based), проставляется после сортировки. */
  index: number
  clientName: string
  /** ФИО контактного лица (первый ClientContact по sortOrder, fallback Client.contactName). */
  contactName: string | null
  /** Телефон контактного лица (тот же приоритет). */
  contactPhone: string | null
  locationName: string
  locationAddress: string
  /** Окно доставки "HH:mm" или null. */
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  portions: number
  mealType: MealType
  packaging: PackagingType
  tags: string[]
  notes: string | null
  orderId: string
}

/** Заголовок группы по окну доставки (для группировки в PDF). */
export interface RouteSheetGroup {
  /** Подпись окна: "11:30–12:00", "с 11:30", "до 12:00" или "Без окна". */
  windowLabel: string
  rows: RouteSheetRow[]
}

export interface BuildRouteSheetOptions {
  /** true → только location.sameDayDelivery=true и статус строго CONFIRMED. */
  sameDayOnly?: boolean
}

/**
 * Резолв контакта клиента: первый ClientContact по sortOrder (затем по
 * createdAt для стабильности), fallback на Client.contactName/contactPhone.
 */
function resolveContact(client: {
  contactName: string | null
  contactPhone: string | null
  contacts: { name: string | null; phone: string }[]
}): { contactName: string | null; contactPhone: string | null } {
  const first = client.contacts[0]
  if (first) {
    return {
      contactName: first.name ?? client.contactName,
      contactPhone: first.phone,
    }
  }
  return { contactName: client.contactName, contactPhone: client.contactPhone }
}

/**
 * Человекочитаемая подпись окна доставки для группировки.
 */
export function windowLabel(from: string | null, to: string | null): string {
  if (from && to) return `${from}–${to}`
  if (from) return `с ${from}`
  if (to) return `до ${to}`
  return 'Без окна'
}

/**
 * П2: строки маршрутного листа на дату доставки.
 *
 * Фильтры:
 *  - client.isActive=true И location.isActive=true (архивные исключены);
 *  - status ∈ [CONFIRMED, LOCKED, IN_PRODUCTION] (для sameDayOnly — только CONFIRMED);
 *  - sameDayOnly → дополнительно location.sameDayDelivery=true.
 *
 * Сортировка: deliveryWindowFrom ASC (null в конце), затем locationAddress ASC.
 * index проставляется после сортировки (1-based).
 */
export async function buildRouteSheetRows(
  deliveryDate: Date,
  opts?: BuildRouteSheetOptions
): Promise<RouteSheetRow[]> {
  const sameDayOnly = opts?.sameDayOnly ?? false

  const date = new Date(deliveryDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const statuses = sameDayOnly ? SAME_DAY_STATUSES : ROUTE_SHEET_STATUSES

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: { in: statuses },
      client: { isActive: true },
      location: {
        isActive: true,
        ...(sameDayOnly ? { sameDayDelivery: true } : {}),
      },
    },
    select: {
      id: true,
      mealType: true,
      portions: true,
      packaging: true,
      tags: true,
      notes: true,
      client: {
        select: {
          name: true,
          contactName: true,
          contactPhone: true,
          contacts: {
            select: { name: true, phone: true },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            take: 1,
          },
        },
      },
      location: {
        select: {
          name: true,
          address: true,
          deliveryWindowFrom: true,
          deliveryWindowTo: true,
        },
      },
    },
  })

  const rows: Omit<RouteSheetRow, 'index'>[] = orders.map((o) => {
    const { contactName, contactPhone } = resolveContact(o.client)
    return {
      clientName: o.client.name,
      contactName,
      contactPhone,
      locationName: o.location.name,
      locationAddress: o.location.address,
      deliveryWindowFrom: o.location.deliveryWindowFrom,
      deliveryWindowTo: o.location.deliveryWindowTo,
      portions: o.portions,
      mealType: o.mealType,
      packaging: o.packaging,
      tags: o.tags,
      notes: o.notes,
      orderId: o.id,
    }
  })

  rows.sort((a, b) => {
    // null окно — в конец (сортируем как '99:99').
    const aFrom = a.deliveryWindowFrom ?? '99:99'
    const bFrom = b.deliveryWindowFrom ?? '99:99'
    if (aFrom !== bFrom) return aFrom.localeCompare(bFrom)
    return a.locationAddress.localeCompare(b.locationAddress, 'ru')
  })

  return rows.map((r, i) => ({ index: i + 1, ...r }))
}

/**
 * Группировка отсортированных строк по окну доставки (для PDF).
 * Сохраняет порядок появления окон (строки уже отсортированы).
 */
export function groupRouteSheetRows(rows: RouteSheetRow[]): RouteSheetGroup[] {
  const groups: RouteSheetGroup[] = []
  let current: RouteSheetGroup | null = null

  for (const row of rows) {
    const label = windowLabel(row.deliveryWindowFrom, row.deliveryWindowTo)
    if (!current || current.windowLabel !== label) {
      current = { windowLabel: label, rows: [] }
      groups.push(current)
    }
    current.rows.push(row)
  }

  return groups
}
