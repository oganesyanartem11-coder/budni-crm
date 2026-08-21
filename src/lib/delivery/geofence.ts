const EARTH_RADIUS_M = 6_371_000
const MAX_ACCURACY_M = 100
const MAX_POSITION_AGE_MS = 60_000
const MAX_FUTURE_SKEW_MS = 5_000
const MIN_GEOFENCE_RADIUS_M = 100
const MAX_GEOFENCE_RADIUS_M = 5_000

export type DeliveryGeoEvaluationResult =
  | 'ALLOWED'
  | 'OUTSIDE_GEOFENCE'
  | 'LOW_ACCURACY'
  | 'STALE_POSITION'
  | 'FUTURE_POSITION'
  | 'INVALID_POSITION'
  | 'POSITION_UNAVAILABLE'
  | 'TARGET_UNAVAILABLE'

export interface DeliveryGeofenceInput {
  courierLatitude: number | null
  courierLongitude: number | null
  accuracyM: number | null
  capturedAt: Date | null
  receivedAt: Date
  targetLatitude: number | null
  targetLongitude: number | null
  radiusM: number
}

export interface DeliveryGeofenceEvaluation {
  result: DeliveryGeoEvaluationResult
  distanceM: number | null
}

function degreesToRadians(value: number): number {
  return value * (Math.PI / 180)
}

function isLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

export function haversineDistanceM(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latitudeDelta = degreesToRadians(latitudeB - latitudeA)
  const longitudeDelta = degreesToRadians(longitudeB - longitudeA)
  const latitudeARadians = degreesToRadians(latitudeA)
  const latitudeBRadians = degreesToRadians(latitudeB)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeARadians)
      * Math.cos(latitudeBRadians)
      * Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

export function evaluateDeliveryGeofence(
  input: DeliveryGeofenceInput,
): DeliveryGeofenceEvaluation {
  if (
    input.targetLatitude === null
    || input.targetLongitude === null
    || !isLatitude(input.targetLatitude)
    || !isLongitude(input.targetLongitude)
    || !Number.isInteger(input.radiusM)
    || input.radiusM < MIN_GEOFENCE_RADIUS_M
    || input.radiusM > MAX_GEOFENCE_RADIUS_M
  ) {
    return { result: 'TARGET_UNAVAILABLE', distanceM: null }
  }

  if (
    input.courierLatitude === null
    || input.courierLongitude === null
    || input.accuracyM === null
    || input.capturedAt === null
  ) {
    return { result: 'POSITION_UNAVAILABLE', distanceM: null }
  }

  if (
    !isLatitude(input.courierLatitude)
    || !isLongitude(input.courierLongitude)
    || !Number.isFinite(input.accuracyM)
    || input.accuracyM < 0
    || !Number.isFinite(input.capturedAt.getTime())
    || !Number.isFinite(input.receivedAt.getTime())
  ) {
    return { result: 'INVALID_POSITION', distanceM: null }
  }

  const distanceM = haversineDistanceM(
    input.courierLatitude,
    input.courierLongitude,
    input.targetLatitude,
    input.targetLongitude,
  )
  const ageMs = input.receivedAt.getTime() - input.capturedAt.getTime()
  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    return { result: 'FUTURE_POSITION', distanceM }
  }
  if (ageMs > MAX_POSITION_AGE_MS) {
    return { result: 'STALE_POSITION', distanceM }
  }
  if (input.accuracyM > MAX_ACCURACY_M) {
    return { result: 'LOW_ACCURACY', distanceM }
  }

  return {
    result: distanceM <= input.radiusM ? 'ALLOWED' : 'OUTSIDE_GEOFENCE',
    distanceM,
  }
}
