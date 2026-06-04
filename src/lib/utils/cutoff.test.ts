import { describe, it, expect } from 'vitest'
import {
  getClientCutoffForDate,
  formatCutoff,
  DEFAULT_CUTOFF,
  type ClientForCutoff,
} from './cutoff'

// deliveryDate в проде хранится как UTC-полночь МСК-календарной даты
// (mskMidnightUtc в daily-summary.ts → Date.UTC(y,m,d) без сдвига зоны).
function mskMidnightUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
}

const SAME_DAY_LOC_ID = 'loc-sameday'
const REGULAR_LOC_ID = 'loc-regular'

const sameDayClient: ClientForCutoff = {
  locations: [
    { id: SAME_DAY_LOC_ID, isActive: true, sameDayDelivery: true, cutoffHourMsk: 8, cutoffMinuteMsk: 40 },
  ],
}

const regularClient: ClientForCutoff = {
  locations: [
    { id: REGULAR_LOC_ID, isActive: true, sameDayDelivery: false, cutoffHourMsk: null, cutoffMinuteMsk: null },
  ],
}

// now = сегодня 06:00 МСК (03:00 UTC)
const NOW = new Date(Date.UTC(2026, 5, 4, 3, 0, 0))
const DELIVERY_TODAY = mskMidnightUtc(2026, 6, 4)
const DELIVERY_TOMORROW = mskMidnightUtc(2026, 6, 5)

describe('getClientCutoffForDate', () => {
  it('same-day локация заказа + доставка сегодня → индивидуальный cut-off 08:40', () => {
    const cutoff = getClientCutoffForDate({
      client: sameDayClient,
      deliveryDate: DELIVERY_TODAY,
      locationId: SAME_DAY_LOC_ID,
      now: NOW,
    })
    expect(cutoff).toEqual({ hour: 8, minute: 40 })
    expect(formatCutoff(cutoff)).toBe('08:40')
  })

  it('обычный клиент → DEFAULT_CUTOFF 16:00', () => {
    const cutoff = getClientCutoffForDate({
      client: regularClient,
      deliveryDate: DELIVERY_TOMORROW,
      locationId: REGULAR_LOC_ID,
      now: NOW,
    })
    expect(cutoff).toEqual(DEFAULT_CUTOFF)
    expect(formatCutoff(cutoff)).toBe('16:00')
  })

  it('same-day локация, но доставка ЗАВТРА → 16:00 (не утренний cut-off)', () => {
    const cutoff = getClientCutoffForDate({
      client: sameDayClient,
      deliveryDate: DELIVERY_TOMORROW,
      locationId: SAME_DAY_LOC_ID,
      now: NOW,
    })
    expect(cutoff).toEqual({ hour: 16, minute: 0 })
  })

  it('клиент с 2 локациями: резолв по locationId заказа (same-day → 08:40, обычная → 16:00)', () => {
    const mixedClient: ClientForCutoff = {
      locations: [
        { id: SAME_DAY_LOC_ID, isActive: true, sameDayDelivery: true, cutoffHourMsk: 8, cutoffMinuteMsk: 40 },
        { id: REGULAR_LOC_ID, isActive: true, sameDayDelivery: false, cutoffHourMsk: null, cutoffMinuteMsk: null },
      ],
    }
    // Заказ на same-day локацию сегодня → её утренний cut-off.
    expect(
      getClientCutoffForDate({
        client: mixedClient,
        deliveryDate: DELIVERY_TODAY,
        locationId: SAME_DAY_LOC_ID,
        now: NOW,
      })
    ).toEqual({ hour: 8, minute: 40 })
    // Заказ на обычную локацию того же клиента сегодня → 16:00 (НЕ унаследовал 08:40).
    expect(
      getClientCutoffForDate({
        client: mixedClient,
        deliveryDate: DELIVERY_TODAY,
        locationId: REGULAR_LOC_ID,
        now: NOW,
      })
    ).toEqual({ hour: 16, minute: 0 })
  })

  it('locationId = null → DEFAULT_CUTOFF (backward compat)', () => {
    expect(
      getClientCutoffForDate({
        client: sameDayClient,
        deliveryDate: DELIVERY_TODAY,
        locationId: null,
        now: NOW,
      })
    ).toEqual(DEFAULT_CUTOFF)
  })

  it('неизвестный locationId → DEFAULT_CUTOFF', () => {
    expect(
      getClientCutoffForDate({
        client: sameDayClient,
        deliveryDate: DELIVERY_TODAY,
        locationId: 'loc-does-not-exist',
        now: NOW,
      })
    ).toEqual(DEFAULT_CUTOFF)
  })

  it('неактивная same-day локация игнорируется → 16:00', () => {
    const client: ClientForCutoff = {
      locations: [
        { id: SAME_DAY_LOC_ID, isActive: false, sameDayDelivery: true, cutoffHourMsk: 8, cutoffMinuteMsk: 40 },
      ],
    }
    expect(
      getClientCutoffForDate({
        client,
        deliveryDate: DELIVERY_TODAY,
        locationId: SAME_DAY_LOC_ID,
        now: NOW,
      })
    ).toEqual(DEFAULT_CUTOFF)
  })

  it('same-day локация заказа с null cut-off → fallback 16:00', () => {
    const client: ClientForCutoff = {
      locations: [
        { id: SAME_DAY_LOC_ID, isActive: true, sameDayDelivery: true, cutoffHourMsk: null, cutoffMinuteMsk: null },
      ],
    }
    expect(
      getClientCutoffForDate({
        client,
        deliveryDate: DELIVERY_TODAY,
        locationId: SAME_DAY_LOC_ID,
        now: NOW,
      })
    ).toEqual({ hour: 16, minute: 0 })
  })
})

describe('formatCutoff', () => {
  it('ведущие нули', () => {
    expect(formatCutoff({ hour: 8, minute: 5 })).toBe('08:05')
    expect(formatCutoff({ hour: 16, minute: 0 })).toBe('16:00')
  })
})
