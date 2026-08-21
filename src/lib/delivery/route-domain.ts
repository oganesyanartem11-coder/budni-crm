import { isDeliveryLate } from '@/lib/delivery/delivery-late'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

export type CourierRouteState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED'
export type CourierRouteStopState = 'PLANNED' | 'NEW' | 'LATE' | 'DELIVERED' | 'CANCELLED'

export interface RouteStateInput {
  startedAt: Date | null
  completedAt: Date | null
}

export interface NewStopInput {
  assignedAt: Date
}

export interface NewStopRouteInput {
  startedAt: Date | null
}

export interface StopStateInput extends NewStopInput {
  deliveryDate: Date
  deliveryWindowToSnapshot: string | null
  deliveredAt: Date | null
  cancelledAt: Date | null
}

export interface RouteOrderInput {
  id: string
  deliveryWindowFromSnapshot: string | null
  deliveredAt: Date | null
  cancelledAt: Date | null
  locationNameSnapshot: string
}

export function getRouteState(route: RouteStateInput): CourierRouteState {
  if (route.completedAt) return 'COMPLETED'
  if (route.startedAt) return 'IN_PROGRESS'
  return 'NOT_STARTED'
}

export function isNewRouteStop(
  stop: NewStopInput,
  route: NewStopRouteInput,
): boolean {
  return Boolean(
    route.startedAt && stop.assignedAt.getTime() > route.startedAt.getTime(),
  )
}

export function getStopState(
  stop: StopStateInput,
  route: NewStopRouteInput,
  now: Date,
): CourierRouteStopState {
  if (stop.cancelledAt) return 'CANCELLED'
  if (stop.deliveredAt) return 'DELIVERED'

  if (isDeliveryLate(
    stop.deliveryDate,
    stop.deliveryWindowToSnapshot,
    now,
  )) {
    return 'LATE'
  }
  if (isNewRouteStop(stop, route)) return 'NEW'
  return 'PLANNED'
}

export function compareRouteStops(a: RouteOrderInput, b: RouteOrderInput): number {
  const stateRank = (stop: RouteOrderInput) => {
    if (stop.cancelledAt) return 2
    if (stop.deliveredAt) return 1
    return 0
  }
  const rankDiff = stateRank(a) - stateRank(b)
  if (rankDiff !== 0) return rankDiff

  const aWindow = a.deliveryWindowFromSnapshot ?? '99:99'
  const bWindow = b.deliveryWindowFromSnapshot ?? '99:99'
  if (aWindow !== bWindow) return aWindow.localeCompare(bWindow)

  const nameDiff = a.locationNameSnapshot.localeCompare(
    b.locationNameSnapshot,
    'ru',
  )
  if (nameDiff !== 0) return nameDiff
  return a.id.localeCompare(b.id)
}

export function normalizeMskDeliveryDate(date: Date): Date {
  return getMskCalendarDayUtc(date)
}
