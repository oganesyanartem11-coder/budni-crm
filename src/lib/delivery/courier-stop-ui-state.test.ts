import { describe, expect, it } from 'vitest'
import {
  completionStateFromGeoResult,
  completionStateFromStop,
  geolocationFailureState,
  getAvailableOverrideGeoAttemptId,
  type CourierCompletionState,
} from './courier-stop-ui-state'

describe('courier stop completion UI state', () => {
  it.each([
    ['OUTSIDE_GEOFENCE', 'outside'],
    ['LOW_ACCURACY', 'low_accuracy'],
    ['STALE_POSITION', 'stale'],
    ['FUTURE_POSITION', 'future'],
    ['INVALID_POSITION', 'invalid'],
    ['POSITION_UNAVAILABLE', 'no_coordinates'],
    ['TARGET_UNAVAILABLE', 'target_unavailable'],
  ] as const)('maps failed server geo result %s to %s', (result, expected) => {
    expect(completionStateFromGeoResult(result, 'attempt-1', 1_250)).toEqual({
      kind: expected,
      geoAttemptId: 'attempt-1',
      distanceM: 1_250,
    })
  })

  it('does not treat ALLOWED as success until the server says delivered', () => {
    expect(completionStateFromGeoResult('ALLOWED', 'attempt-1', 500)).toEqual({
      kind: 'submitting',
    })
  })

  it.each([
    [1, 'denied'],
    [2, 'no_coordinates'],
    [3, 'timeout'],
    [99, 'no_coordinates'],
  ] as const)('maps browser geolocation error %i to %s', (code, kind) => {
    expect(geolocationFailureState(code)).toEqual({ kind })
  })

  it.each([
    [{ deliveredAt: new Date(), overrideStatus: null }, 'delivered'],
    [{ deliveredAt: null, overrideStatus: 'PENDING' }, 'override_pending'],
    [{ deliveredAt: null, overrideStatus: 'APPROVED' }, 'override_approved'],
    [{ deliveredAt: null, overrideStatus: 'REJECTED' }, 'override_rejected'],
    [{ deliveredAt: null, overrideStatus: 'EXPIRED' }, 'override_expired'],
    [{ deliveredAt: null, overrideStatus: null }, 'idle'],
  ] as const)('derives persisted state as %s', (input, kind) => {
    expect(completionStateFromStop(input as Parameters<typeof completionStateFromStop>[0]))
      .toEqual({ kind })
  })

  it('models offline independently from geolocation failures', () => {
    const state: CourierCompletionState = { kind: 'offline' }
    expect(state.kind).toBe('offline')
  })

  it('restores only a failed attempt that has not already been used for override', () => {
    expect(getAvailableOverrideGeoAttemptId({
      latestGeoAttemptId: 'attempt-fresh',
      overrideRequestId: null,
      deliveredAt: null,
    })).toBe('attempt-fresh')

    expect(getAvailableOverrideGeoAttemptId({
      latestGeoAttemptId: 'attempt-used',
      overrideRequestId: 'override-1',
      deliveredAt: null,
    })).toBeNull()

    expect(getAvailableOverrideGeoAttemptId({
      latestGeoAttemptId: 'attempt-after-rejection',
      overrideRequestId: null,
      deliveredAt: null,
    })).toBe('attempt-after-rejection')
  })

  it('never restores an override action for a delivered stop', () => {
    expect(getAvailableOverrideGeoAttemptId({
      latestGeoAttemptId: 'attempt-1',
      overrideRequestId: null,
      deliveredAt: new Date(),
    })).toBeNull()
  })
})
