import type { DeliveryGeoResult, DeliveryOverrideStatus } from '@prisma/client'

type FailedGeoStateKind =
  | 'outside'
  | 'low_accuracy'
  | 'stale'
  | 'future'
  | 'invalid'
  | 'no_coordinates'
  | 'target_unavailable'

export type CourierCompletionState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'submitting' }
  | { kind: 'delivered' }
  | { kind: 'offline' }
  | { kind: 'denied' }
  | { kind: 'timeout' }
  | { kind: 'no_coordinates' }
  | { kind: 'server_error'; message: string }
  | { kind: 'override_submitting' }
  | { kind: 'override_pending' }
  | { kind: 'override_approved' }
  | { kind: 'override_rejected' }
  | { kind: 'override_expired' }
  | {
      kind: FailedGeoStateKind
      geoAttemptId: string
      distanceM: number | null
    }

const FAILED_GEO_STATE: Partial<Record<DeliveryGeoResult, FailedGeoStateKind>> = {
  OUTSIDE_GEOFENCE: 'outside',
  LOW_ACCURACY: 'low_accuracy',
  STALE_POSITION: 'stale',
  FUTURE_POSITION: 'future',
  INVALID_POSITION: 'invalid',
  POSITION_UNAVAILABLE: 'no_coordinates',
  TARGET_UNAVAILABLE: 'target_unavailable',
}

export function completionStateFromGeoResult(
  result: DeliveryGeoResult,
  geoAttemptId: string,
  distanceM: number | null,
): CourierCompletionState {
  const kind = FAILED_GEO_STATE[result]
  if (!kind) return { kind: 'submitting' }
  return { kind, geoAttemptId, distanceM }
}

export function geolocationFailureState(code: number): CourierCompletionState {
  if (code === 1) return { kind: 'denied' }
  if (code === 3) return { kind: 'timeout' }
  return { kind: 'no_coordinates' }
}

export function completionStateFromStop(input: {
  deliveredAt: Date | string | null
  overrideStatus: DeliveryOverrideStatus | null
}): CourierCompletionState {
  if (input.deliveredAt) return { kind: 'delivered' }
  if (input.overrideStatus === 'PENDING') return { kind: 'override_pending' }
  if (input.overrideStatus === 'APPROVED') return { kind: 'override_approved' }
  if (input.overrideStatus === 'REJECTED') return { kind: 'override_rejected' }
  if (input.overrideStatus === 'EXPIRED') return { kind: 'override_expired' }
  return { kind: 'idle' }
}

export function getAvailableOverrideGeoAttemptId(input: {
  latestGeoAttemptId: string | null
  overrideRequestId: string | null
  deliveredAt: Date | string | null
}): string | null {
  if (input.deliveredAt || !input.latestGeoAttemptId || input.overrideRequestId) {
    return null
  }
  return input.latestGeoAttemptId
}
