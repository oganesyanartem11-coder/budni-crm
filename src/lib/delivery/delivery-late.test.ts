import { describe, expect, it } from 'vitest'
import {
  DELIVERY_LATE_THRESHOLD_MINUTES,
  getDeliveryDelayMinutes,
  isDeliveryDelayLate,
  isDeliveryLate,
} from './delivery-late'

const deliveryDate = new Date('2026-08-21T00:00:00.000Z')

describe('delivery late policy', () => {
  it('uses one strict +20 minute boundary for UI, analytics and alerts', () => {
    expect(DELIVERY_LATE_THRESHOLD_MINUTES).toBe(20)
    expect(isDeliveryLate(deliveryDate, '10:00', new Date('2026-08-21T07:19:59.000Z'))).toBe(false)
    expect(isDeliveryLate(deliveryDate, '10:00', new Date('2026-08-21T07:20:00.000Z'))).toBe(false)
    expect(isDeliveryLate(deliveryDate, '10:00', new Date('2026-08-21T07:20:01.000Z'))).toBe(true)
    expect(isDeliveryDelayLate(20)).toBe(false)
    expect(isDeliveryDelayLate(20 + 1 / 60)).toBe(true)
  })

  it('returns a non-negative delay and null for a missing or invalid window', () => {
    expect(getDeliveryDelayMinutes(deliveryDate, '10:00', new Date('2026-08-21T06:59:00.000Z'))).toBe(0)
    expect(getDeliveryDelayMinutes(deliveryDate, '10:00', new Date('2026-08-21T07:20:01.000Z')))
      .toBeCloseTo(20 + 1 / 60)
    expect(getDeliveryDelayMinutes(deliveryDate, null, new Date())).toBeNull()
    expect(getDeliveryDelayMinutes(deliveryDate, 'invalid', new Date())).toBeNull()
  })
})
