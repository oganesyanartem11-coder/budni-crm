import type { MealType, OrderStatus, Prisma, UserRole } from '@prisma/client'

export const DELIVERY_STOP_FORBIDDEN_ERROR = 'Остановка недоступна или не найдена'
export const DELIVERY_STOP_VERSION_ERROR =
  'Данные остановки изменились. Обновите страницу и повторите попытку'

export const LEGACY_DELIVERY_ORDER_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

const LEGACY_DELIVERY_STATUS_SET = new Set<OrderStatus>(LEGACY_DELIVERY_ORDER_STATUSES)

export class DeliveryStopAccessError extends Error {
  constructor() {
    super(DELIVERY_STOP_FORBIDDEN_ERROR)
    this.name = 'DeliveryStopAccessError'
  }
}

export class DeliveryStopVersionError extends Error {
  constructor() {
    super(DELIVERY_STOP_VERSION_ERROR)
    this.name = 'DeliveryStopVersionError'
  }
}

export interface DeliveryActor {
  id: string
  role: UserRole
  name: string
}

export interface LegacyStopOrder {
  id: string
  routeStopId?: string | null
  clientId: string
  locationId: string
  deliveryDate: Date
  status: OrderStatus
  updatedAt: Date
  portions: number
  mealType: MealType
  client: { name: string }
  location: {
    id: string
    name: string
    assignedCourierId: string | null
    deliveryWindowFrom: string | null
    deliveryWindowTo: string | null
  }
  delivery: {
    id: string
    courierName: string | null
    deliveredAt: Date | null
  } | null
}

export function normalizeLegacyStopOrderIds(orderIds: readonly string[]): string[] {
  if (!Array.isArray(orderIds)) throw new DeliveryStopAccessError()
  if (orderIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
    throw new DeliveryStopAccessError()
  }

  const normalized = Array.from(
    new Set(
      orderIds
        .map((id) => id.trim())
    ),
  )
  if (normalized.length === 0) throw new DeliveryStopAccessError()
  return normalized
}

export function validateLegacyStopSnapshot(
  orderIds: readonly string[],
  selectedOrders: readonly LegacyStopOrder[],
  relevantOrders: readonly LegacyStopOrder[],
  viewer: DeliveryActor,
): LegacyStopOrder[] {
  const normalizedIds = normalizeLegacyStopOrderIds(orderIds)
  const requestedIds = new Set(normalizedIds)

  if (
    selectedOrders.length !== normalizedIds.length ||
    selectedOrders.some((order) => !requestedIds.has(order.id))
  ) {
    throw new DeliveryStopAccessError()
  }

  const anchor = selectedOrders[0]
  if (!anchor || !LEGACY_DELIVERY_STATUS_SET.has(anchor.status)) {
    throw new DeliveryStopAccessError()
  }

  const anchorDate = anchor.deliveryDate.getTime()
  const isSamePhysicalStop = (order: LegacyStopOrder) =>
    order.clientId === anchor.clientId &&
    order.locationId === anchor.locationId &&
    order.deliveryDate.getTime() === anchorDate &&
    LEGACY_DELIVERY_STATUS_SET.has(order.status)

  if (!selectedOrders.every(isSamePhysicalStop)) {
    throw new DeliveryStopAccessError()
  }

  const managerAllowed = ['ADMIN_PRO', 'ADMIN', 'MANAGER'].includes(viewer.role)
  const courierAllowed =
    viewer.role === 'COURIER' && anchor.location.assignedCourierId === viewer.id
  if (!managerAllowed && !courierAllowed) {
    throw new DeliveryStopAccessError()
  }

  if (
    relevantOrders.length !== normalizedIds.length ||
    !relevantOrders.every(
      (order) => requestedIds.has(order.id) && isSamePhysicalStop(order),
    )
  ) {
    throw new DeliveryStopAccessError()
  }

  return [...relevantOrders]
}

export function assertLegacyStopExpectedVersions(
  orders: readonly LegacyStopOrder[],
  expectedUpdatedAts: Readonly<Record<string, string>> | undefined,
): LegacyStopOrder[] {
  const nonDelivered = orders.filter((order) => order.status !== 'DELIVERED')
  if (nonDelivered.length === 0) return []

  for (const order of nonDelivered) {
    if (expectedUpdatedAts?.[order.id] !== order.updatedAt.toISOString()) {
      throw new DeliveryStopVersionError()
    }
  }
  return nonDelivered
}

const LEGACY_STOP_ORDER_SELECT = {
  id: true,
  routeStopId: true,
  clientId: true,
  locationId: true,
  deliveryDate: true,
  status: true,
  updatedAt: true,
  portions: true,
  mealType: true,
  client: { select: { name: true } },
  location: {
    select: {
      id: true,
      name: true,
      assignedCourierId: true,
      deliveryWindowFrom: true,
      deliveryWindowTo: true,
    },
  },
  delivery: {
    select: {
      id: true,
      courierName: true,
      deliveredAt: true,
    },
  },
} as const

/**
 * Loads and authorizes a complete legacy physical stop. Both reads are meant
 * to run on the same interactive transaction as the subsequent mutation.
 */
export async function loadLegacyPhysicalStop(
  tx: Prisma.TransactionClient,
  orderIds: readonly string[],
  viewer: DeliveryActor,
): Promise<{ orderIds: string[]; orders: LegacyStopOrder[] }> {
  const normalizedIds = normalizeLegacyStopOrderIds(orderIds)
  const selectedOrders = await tx.order.findMany({
    where: { id: { in: normalizedIds } },
    select: LEGACY_STOP_ORDER_SELECT,
  })

  // Validate missing/forbidden/mixed input and ownership before using its
  // physical-stop coordinates for the complete-set query.
  validateLegacyStopSnapshot(normalizedIds, selectedOrders, selectedOrders, viewer)
  const anchor = selectedOrders[0]!

  const relevantOrders = await tx.order.findMany({
    where: {
      clientId: anchor.clientId,
      locationId: anchor.locationId,
      deliveryDate: anchor.deliveryDate,
      status: { in: LEGACY_DELIVERY_ORDER_STATUSES },
    },
    select: LEGACY_STOP_ORDER_SELECT,
  })

  return {
    orderIds: normalizedIds,
    orders: validateLegacyStopSnapshot(
      normalizedIds,
      selectedOrders,
      relevantOrders,
      viewer,
    ),
  }
}
