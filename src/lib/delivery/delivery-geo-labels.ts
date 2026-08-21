import type { DeliveryGeoResult } from '@prisma/client'

export const DELIVERY_GEO_RESULT_LABELS: Record<DeliveryGeoResult, string> = {
  ALLOWED: 'В геозоне',
  OUTSIDE_GEOFENCE: 'Вне геозоны',
  LOW_ACCURACY: 'Низкая точность GPS',
  STALE_POSITION: 'Позиция устарела',
  FUTURE_POSITION: 'Некорректное время позиции',
  INVALID_POSITION: 'Некорректные координаты',
  POSITION_UNAVAILABLE: 'Позиция недоступна',
  TARGET_UNAVAILABLE: 'Координаты точки не заданы',
  GEOFENCE_NOT_REQUIRED: 'Геозона не требуется',
}

export function getDeliveryGeoResultLabel(result: DeliveryGeoResult): string {
  return DELIVERY_GEO_RESULT_LABELS[result]
}
