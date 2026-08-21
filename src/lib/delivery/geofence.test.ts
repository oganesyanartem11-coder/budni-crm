import { describe, expect, it } from 'vitest'
import {
  evaluateDeliveryGeofence,
  haversineDistanceM,
  type DeliveryGeofenceInput,
} from './geofence'

const EARTH_RADIUS_M = 6_371_000
const receivedAt = new Date('2026-08-12T08:00:00.000Z')

function longitudeAtDistanceM(distanceM: number): number {
  return (distanceM / EARTH_RADIUS_M) * (180 / Math.PI)
}

function input(overrides: Partial<DeliveryGeofenceInput> = {}): DeliveryGeofenceInput {
  return {
    courierLatitude: 0,
    courierLongitude: longitudeAtDistanceM(500),
    accuracyM: 25,
    capturedAt: new Date(receivedAt.getTime() - 10_000),
    receivedAt,
    targetLatitude: 0,
    targetLongitude: 0,
    radiusM: 1_000,
    ...overrides,
  }
}

describe('haversineDistanceM', () => {
  it('calculates deterministic great-circle distance in metres', () => {
    expect(haversineDistanceM(0, 0, 0, longitudeAtDistanceM(1_000)))
      .toBeCloseTo(1_000, 6)
  })
})

describe('evaluateDeliveryGeofence', () => {
  it.each([
    [500, 'ALLOWED'],
    [1_000, 'ALLOWED'],
    [1_001, 'OUTSIDE_GEOFENCE'],
  ] as const)('classifies %i m against an inclusive 1000 m radius', (distance, result) => {
    const evaluated = evaluateDeliveryGeofence(input({
      courierLongitude: longitudeAtDistanceM(distance),
    }))

    expect(evaluated.result).toBe(result)
    expect(evaluated.distanceM).toBeCloseTo(distance, 5)
  })

  it('allows exactly 100 m accuracy and rejects anything worse', () => {
    expect(evaluateDeliveryGeofence(input({ accuracyM: 100 })).result).toBe('ALLOWED')
    expect(evaluateDeliveryGeofence(input({ accuracyM: 100.01 }))).toEqual({
      result: 'LOW_ACCURACY',
      distanceM: expect.closeTo(500, 5),
    })
  })

  it('allows a position exactly 60 seconds old and rejects an older one', () => {
    expect(evaluateDeliveryGeofence(input({
      capturedAt: new Date(receivedAt.getTime() - 60_000),
    })).result).toBe('ALLOWED')
    expect(evaluateDeliveryGeofence(input({
      capturedAt: new Date(receivedAt.getTime() - 60_001),
    }))).toEqual({
      result: 'STALE_POSITION',
      distanceM: expect.closeTo(500, 5),
    })
  })

  it('allows up to five seconds of clock skew and rejects a later future position', () => {
    expect(evaluateDeliveryGeofence(input({
      capturedAt: new Date(receivedAt.getTime() + 5_000),
    })).result).toBe('ALLOWED')
    expect(evaluateDeliveryGeofence(input({
      capturedAt: new Date(receivedAt.getTime() + 5_001),
    })).result).toBe('FUTURE_POSITION')
  })

  it('returns typed failures for unavailable target and courier position', () => {
    expect(evaluateDeliveryGeofence(input({ targetLatitude: null })).result)
      .toBe('TARGET_UNAVAILABLE')
    expect(evaluateDeliveryGeofence(input({ courierLatitude: null })).result)
      .toBe('POSITION_UNAVAILABLE')
  })

  it('rejects a snapshot radius outside the configured 100–5000 m range', () => {
    expect(evaluateDeliveryGeofence(input({ radiusM: 99 }))).toEqual({
      result: 'TARGET_UNAVAILABLE',
      distanceM: null,
    })
    expect(evaluateDeliveryGeofence(input({ radiusM: 100 })).result).toBe('OUTSIDE_GEOFENCE')
    expect(evaluateDeliveryGeofence(input({ radiusM: 5_000 })).result).toBe('ALLOWED')
    expect(evaluateDeliveryGeofence(input({ radiusM: 5_001 }))).toEqual({
      result: 'TARGET_UNAVAILABLE',
      distanceM: null,
    })
  })

  it('rejects invalid coordinates and accuracy without calculating distance', () => {
    expect(evaluateDeliveryGeofence(input({ courierLatitude: 91 }))).toEqual({
      result: 'INVALID_POSITION',
      distanceM: null,
    })
    expect(evaluateDeliveryGeofence(input({ accuracyM: -1 }))).toEqual({
      result: 'INVALID_POSITION',
      distanceM: null,
    })
  })
})
