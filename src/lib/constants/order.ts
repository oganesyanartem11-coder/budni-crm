import type { OrderStatus, DeliveryStatus } from '@prisma/client'

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  PENDING_CONFIRMATION: 'Ждёт подтверждения',
  CONFIRMED: 'Подтверждён',
  LOCKED: 'Зафиксирован',
  IN_PRODUCTION: 'На производстве',
  OUT_FOR_DELIVERY: 'В доставке',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
}

export const ORDER_STATUS_VARIANT: Record<OrderStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  DRAFT: 'neutral',
  PENDING_CONFIRMATION: 'warning',
  CONFIRMED: 'success',
  LOCKED: 'info',
  IN_PRODUCTION: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  CANCELLED: 'neutral',
}

// Активные статусы — те которые в работе (не отменены и не доставлены)
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
]

// Статусы, формирующие выручку: дошедшие до подтверждения и далее, плюс доставленные.
// Используется во всех агрегаторах денег (dashboard, reports, client-analytics, дайджесты).
// Раньше дублировалось локально в 4 файлах — вынесено сюда для consistency.
// НЕ readonly: Prisma WhereInput требует мутабельный OrderStatus[] для status.in.
export const REVENUE_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

export const ORDER_STATUS_GROUPS = {
  pending: ['PENDING_CONFIRMATION'] as OrderStatus[],
  confirmed: ['CONFIRMED', 'LOCKED'] as OrderStatus[],
  inProgress: ['IN_PRODUCTION', 'OUT_FOR_DELIVERY'] as OrderStatus[],
  done: ['DELIVERED'] as OrderStatus[],
  cancelled: ['CANCELLED', 'DRAFT'] as OrderStatus[],
}

export const MEAL_TYPE_FILTER_LABELS = {
  ALL: 'Все',
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
} as const

/**
 * Toast при успешной правке порций — используется в orders-list (PortionsCell)
 * и в /orders/[id] (handleEditPortions). Если правка попала «после cut-off»
 * (lock-этап) — отдельная формулировка с предупреждением.
 */
export function portionsEditedToast(num: number, afterLock: boolean): string {
  return afterLock
    ? `Сохранено: ${num}. Правка после 16:00 — кухню и курьера предупредят.`
    : `Порций изменено: ${num}`
}
