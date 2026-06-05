import { prisma } from '@/lib/db/prisma'
import { Prisma, type OrderStatus } from '@prisma/client'
import { withDbRetry } from '@/lib/db-retry'

/**
 * Волна 4: «сервисная выручка» — стоимость доставки (ClientLocation.deliveryFee).
 *
 * КЛЮЧЕВАЯ МОДЕЛЬ: fee считается ОДИН раз на (локация, день-с-доставкой), а НЕ
 * на каждый заказ. У одной локации в один день может быть несколько mealType-
 * заказов (завтрак/обед/ужин) — доставка всё равно одна. Поэтому дедупим по
 * паре (locationId, deliveryDate). Локации с deliveryFee = null трактуются как
 * «доставка бесплатная» и в сумму не входят (полная обратная совместимость).
 *
 * Доставка НЕ входит в маржу (маржа считается только по еде) — этот модуль
 * лишь отдаёт суммы; решение про маржу принимается у вызывающих.
 */

// Статусы заказа, считающиеся выручкой (CANCELLED/DRAFT/PENDING — НЕ выручка).
const REVENUE_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

export interface DeliveryRevenueByDay {
  date: Date
  deliveryRevenue: Prisma.Decimal
}

export interface DeliveryRevenueByLocation {
  locationId: string
  locationName: string
  clientId: string
  clientName: string
  deliveryRevenue: Prisma.Decimal
  daysWithDelivery: number
}

export interface DeliveryRevenueByClient {
  clientId: string
  clientName: string
  deliveryRevenue: Prisma.Decimal
}

interface UniqueDeliveryDay {
  locationId: string
  locationName: string
  clientId: string
  clientName: string
  deliveryDate: Date
  deliveryFee: Prisma.Decimal
}

/**
 * Уникальные (locationId, deliveryDate) пары за период [from, to) для заказов в
 * revenue-статусах, у локации которых задан deliveryFee. Дедуп в JS по паре
 * (locationId, deliveryDate) — источник правды «одна доставка в день на локацию».
 * `distinct` в запросе — лишь оптимизация (меньше строк из БД); корректность
 * гарантирует JS-дедуп.
 */
async function getUniqueDeliveryDays(params: {
  from: Date
  to: Date
}): Promise<UniqueDeliveryDay[]> {
  const rows = await withDbRetry(
    () =>
      prisma.order.findMany({
        where: {
          status: { in: REVENUE_STATUSES },
          deliveryDate: { gte: params.from, lt: params.to },
        },
        distinct: ['locationId', 'deliveryDate'],
        select: {
          locationId: true,
          deliveryDate: true,
          location: {
            select: {
              name: true,
              deliveryFee: true,
              clientId: true,
              client: { select: { name: true } },
            },
          },
        },
      }),
    { label: 'delivery-revenue' }
  )

  const seen = new Set<string>()
  const result: UniqueDeliveryDay[] = []
  for (const r of rows) {
    const fee = r.location?.deliveryFee
    // null/отсутствие → доставка бесплатная, не учитываем.
    if (fee == null) continue
    const key = `${r.locationId}|${r.deliveryDate.toISOString()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      locationId: r.locationId,
      locationName: r.location?.name ?? '',
      clientId: r.location?.clientId ?? '',
      clientName: r.location?.client?.name ?? '',
      deliveryDate: r.deliveryDate,
      deliveryFee: fee,
    })
  }
  return result
}

/** Полная сумма сервисной выручки за период [from, to). Decimal-точность. */
export async function sumDeliveryRevenue(params: {
  from: Date
  to: Date
}): Promise<Prisma.Decimal> {
  const days = await getUniqueDeliveryDays(params)
  return days.reduce(
    (acc, d) => acc.add(d.deliveryFee),
    new Prisma.Decimal(0)
  )
}

/** Сервисная выручка по дням (для daily-map дашборда/отчётов). */
export async function deliveryRevenueByDay(params: {
  from: Date
  to: Date
}): Promise<DeliveryRevenueByDay[]> {
  const days = await getUniqueDeliveryDays(params)
  const map = new Map<string, { date: Date; sum: Prisma.Decimal }>()
  for (const d of days) {
    const key = d.deliveryDate.toISOString()
    const ex = map.get(key)
    if (ex) ex.sum = ex.sum.add(d.deliveryFee)
    else map.set(key, { date: d.deliveryDate, sum: d.deliveryFee })
  }
  return Array.from(map.values())
    .map((v) => ({ date: v.date, deliveryRevenue: v.sum }))
    .sort((a, b) => a.date.getTime() - b.date.getTime())
}

/** Сервисная выручка по локациям (+ число дней с доставкой). */
export async function deliveryRevenueByLocation(params: {
  from: Date
  to: Date
}): Promise<DeliveryRevenueByLocation[]> {
  const days = await getUniqueDeliveryDays(params)
  const map = new Map<string, DeliveryRevenueByLocation>()
  for (const d of days) {
    const ex = map.get(d.locationId)
    if (ex) {
      ex.deliveryRevenue = ex.deliveryRevenue.add(d.deliveryFee)
      ex.daysWithDelivery += 1
    } else {
      map.set(d.locationId, {
        locationId: d.locationId,
        locationName: d.locationName,
        clientId: d.clientId,
        clientName: d.clientName,
        deliveryRevenue: d.deliveryFee,
        daysWithDelivery: 1,
      })
    }
  }
  return Array.from(map.values())
}

/** Сервисная выручка по клиентам. */
export async function deliveryRevenueByClient(params: {
  from: Date
  to: Date
}): Promise<DeliveryRevenueByClient[]> {
  const days = await getUniqueDeliveryDays(params)
  const map = new Map<string, DeliveryRevenueByClient>()
  for (const d of days) {
    const ex = map.get(d.clientId)
    if (ex) ex.deliveryRevenue = ex.deliveryRevenue.add(d.deliveryFee)
    else
      map.set(d.clientId, {
        clientId: d.clientId,
        clientName: d.clientName,
        deliveryRevenue: d.deliveryFee,
      })
  }
  return Array.from(map.values())
}
