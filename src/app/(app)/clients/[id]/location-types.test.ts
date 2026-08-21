import { describe, expect, it } from 'vitest'
import {
  parseCoordinateInput,
  resolveLocationDeliveryMode,
} from './location-types'

describe('location settings UI helpers', () => {
  it('keeps explicit modes and resolves the legacy courier default', () => {
    expect(resolveLocationDeliveryMode('UNASSIGNED', 'courier_1')).toBe('UNASSIGNED')
    expect(resolveLocationDeliveryMode(null, 'courier_1')).toBe('IN_HOUSE')
    expect(resolveLocationDeliveryMode(null, null)).toBe('EXTERNAL')
  })

  it('accepts decimal comma without confusing a blank or invalid coordinate', () => {
    expect(parseCoordinateInput('55,7558')).toEqual({ ok: true, value: 55.7558 })
    expect(parseCoordinateInput('')).toEqual({ ok: true, value: null })
    expect(parseCoordinateInput('55,7,8')).toEqual({ ok: false })
  })
})
