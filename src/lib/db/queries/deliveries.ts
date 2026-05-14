import { prisma } from '@/lib/db/prisma'
import type { OrderStatus, MealType, PackagingType } from '@prisma/client'

const DELIVERY_STATUSES: OrderStatus[] = [
  'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY', 'DELIVERED',
]

export interface DeliveryOrderItem {
  orderId: string
  mealType: MealType
  portions: number
  packaging: PackagingType
}

export interface DeliveryStop {
  clientId: string
  clientName: string
  clientContactPhone: string | null
  locationId: string
  locationName: string
  locationAddress: string
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  tags: string[]
  notes: string | null
  totalPortions: number
  items: DeliveryOrderItem[]
  isDelivered: boolean
  deliveredAt: Date | null
  orderIds: string[]
  hasOutForDelivery: boolean
  // 6.4: hasLateAlert — хоть один Order этой остановки опаздывает > 30 мин и про него
  // уже ушёл алёрт в групповой Telegram (lateAlertSentAt set). UI подсвечивает
  // карточку красным.
  hasLateAlert: boolean
  // 6.7: курьер сообщил о проблеме с доставкой (issueReportedAt set на любой
  // Delivery остановки). Берём самые свежие данные (max issueReportedAt).
  issueReportedAt: Date | null
  issueReason: string | null
  issueComment: string | null
}

export async function getDeliveriesForDate(targetDate: Date): Promise<DeliveryStop[]> {
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: { in: DELIVERY_STATUSES },
    },
    include: {
      client: { select: { id: true, name: true, contactPhone: true } },
      location: {
        select: {
          id: true, name: true, address: true,
          deliveryWindowFrom: true, deliveryWindowTo: true,
          tags: true,
        },
      },
      delivery: { select: { deliveredAt: true, issueReportedAt: true, issueReason: true, issueComment: true } },
    },
    orderBy: [
      { deliveryDate: 'asc' },
    ],
  })

  const stopsMap = new Map<string, DeliveryStop>()
  for (const o of orders) {
    const key = `${o.clientId}|${o.locationId}`
    let stop = stopsMap.get(key)
    if (!stop) {
      stop = {
        clientId: o.client.id,
        clientName: o.client.name,
        clientContactPhone: o.client.contactPhone,
        locationId: o.location.id,
        locationName: o.location.name,
        locationAddress: o.location.address,
        deliveryWindowFrom: o.location.deliveryWindowFrom,
        deliveryWindowTo: o.location.deliveryWindowTo,
        tags: o.location.tags,
        notes: null,
        totalPortions: 0,
        items: [],
        isDelivered: true,
        deliveredAt: null,
        orderIds: [],
        hasOutForDelivery: false,
        hasLateAlert: false,
        issueReportedAt: null,
        issueReason: null,
        issueComment: null,
      }
      stopsMap.set(key, stop)
    }

    stop.totalPortions += o.portions
    stop.items.push({
      orderId: o.id,
      mealType: o.mealType,
      portions: o.portions,
      packaging: o.packaging,
    })
    stop.orderIds.push(o.id)

    if (o.status !== 'DELIVERED') stop.isDelivered = false
    if (o.status === 'OUT_FOR_DELIVERY') stop.hasOutForDelivery = true
    if (o.lateAlertSentAt) stop.hasLateAlert = true
    if (o.delivery?.deliveredAt) {
      const da = o.delivery.deliveredAt
      if (!stop.deliveredAt || da > stop.deliveredAt) stop.deliveredAt = da
    }
    if (o.delivery?.issueReportedAt) {
      const ra = o.delivery.issueReportedAt
      if (!stop.issueReportedAt || ra > stop.issueReportedAt) {
        stop.issueReportedAt = ra
        stop.issueReason = o.delivery.issueReason
        stop.issueComment = o.delivery.issueComment
      }
    }

    if (o.notes) {
      stop.notes = stop.notes ? `${stop.notes}\n${o.notes}` : o.notes
    }
  }

  const stops = Array.from(stopsMap.values())

  stops.sort((a, b) => {
    if (a.isDelivered !== b.isDelivered) return a.isDelivered ? 1 : -1
    const aFrom = a.deliveryWindowFrom ?? '99:99'
    const bFrom = b.deliveryWindowFrom ?? '99:99'
    if (aFrom !== bFrom) return aFrom.localeCompare(bFrom)
    return a.clientName.localeCompare(b.clientName, 'ru')
  })

  return stops
}
