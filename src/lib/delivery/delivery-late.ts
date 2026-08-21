import { parseWindowToDate } from '@/lib/utils/msk-window'

export const DELIVERY_LATE_THRESHOLD_MINUTES = 20

export interface DeliveryLateEvaluation {
  windowEnd: Date | null
  delayMinutes: number | null
  isLate: boolean
}

export function isDeliveryDelayLate(delayMinutes: number): boolean {
  return Number.isFinite(delayMinutes)
    && delayMinutes > DELIVERY_LATE_THRESHOLD_MINUTES
}

/**
 * Единая политика опоздания Delivery 2.0 для UI, аналитики и cron.
 * Порог строгий: ровно +20:00 ещё не считается опозданием.
 */
export function evaluateDeliveryLate(
  deliveryDate: Date,
  deliveryWindowTo: string | null,
  at: Date,
): DeliveryLateEvaluation {
  const windowEnd = parseWindowToDate(deliveryWindowTo, deliveryDate)
  if (!windowEnd || Number.isNaN(at.getTime())) {
    return { windowEnd, delayMinutes: null, isLate: false }
  }

  const delayMinutes = Math.max(
    0,
    (at.getTime() - windowEnd.getTime()) / 60_000,
  )
  return {
    windowEnd,
    delayMinutes,
    isLate: isDeliveryDelayLate(delayMinutes),
  }
}

export function isDeliveryLate(
  deliveryDate: Date,
  deliveryWindowTo: string | null,
  at: Date,
): boolean {
  return evaluateDeliveryLate(deliveryDate, deliveryWindowTo, at).isLate
}

export function getDeliveryDelayMinutes(
  deliveryDate: Date,
  deliveryWindowTo: string | null,
  at: Date,
): number | null {
  return evaluateDeliveryLate(deliveryDate, deliveryWindowTo, at).delayMinutes
}
