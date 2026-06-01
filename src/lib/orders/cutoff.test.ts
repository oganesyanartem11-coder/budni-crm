import { describe, it, expect } from 'vitest'
import { getCutoffMoment, getTodayCutoffMomentMsk } from './cutoff'

/**
 * Тесты cut-off helper'ов (Спринт 7.39, same-day delivery).
 * Москва круглый год UTC+3 (нет DST), поэтому конверсии стабильны:
 *   16:00 МСК = 13:00 UTC, 08:40 МСК = 05:40 UTC.
 * Используем фиксированные UTC-инстансты, без Date.now().
 */

describe('getCutoffMoment', () => {
  it('дефолт: 16:00 МСК (=13:00 UTC) дня ПЕРЕД deliveryDate', () => {
    // deliveryDate = 2026-06-02 → день перед = 2026-06-01 16:00 МСК = 13:00 UTC
    const deliveryDate = new Date('2026-06-02T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate)
    expect(result.toISOString()).toBe('2026-06-01T13:00:00.000Z')
  })

  it('кастомный 8:40 МСК (=05:40 UTC) дня перед deliveryDate', () => {
    const deliveryDate = new Date('2026-06-02T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate, 8, 40)
    expect(result.toISOString()).toBe('2026-06-01T05:40:00.000Z')
  })

  it('8:40 МСК = 05:40 UTC (МСК = UTC+3) — проверка конверсии', () => {
    const deliveryDate = new Date('2026-12-15T00:00:00.000Z') // зима — DST в МСК отсутствует
    const result = getCutoffMoment(deliveryDate, 8, 40)
    expect(result.toISOString()).toBe('2026-12-14T05:40:00.000Z')
  })

  it('переход через границу месяца: deliveryDate=1 числа → cut-off в последний день пред. месяца', () => {
    const deliveryDate = new Date('2026-07-01T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate, 8, 40)
    expect(result.toISOString()).toBe('2026-06-30T05:40:00.000Z')
  })
})

describe('getTodayCutoffMomentMsk', () => {
  it('дефолт: 16:00 МСК сегодня (=13:00 UTC)', () => {
    const now = new Date('2026-06-01T09:00:00.000Z') // МСК 12:00 → сегодня = 2026-06-01
    const result = getTodayCutoffMomentMsk(now)
    expect(result.toISOString()).toBe('2026-06-01T13:00:00.000Z')
  })

  it('кастомный 8:40 МСК сегодня (=05:40 UTC)', () => {
    const now = new Date('2026-06-01T09:00:00.000Z') // МСК 12:00
    const result = getTodayCutoffMomentMsk(now, 8, 40)
    expect(result.toISOString()).toBe('2026-06-01T05:40:00.000Z')
  })

  it('8:40 МСК = 05:40 UTC: «сегодня» по календарю МСК, не UTC (окно 00:00-03:00 МСК)', () => {
    // UTC 2026-05-31 22:00 = МСК 2026-06-01 01:00 → «сегодня» по МСК = 2026-06-01
    const now = new Date('2026-05-31T22:00:00.000Z')
    const result = getTodayCutoffMomentMsk(now, 8, 40)
    expect(result.toISOString()).toBe('2026-06-01T05:40:00.000Z')
  })

  it('поздний вечер UTC уже «завтра», но cut-off строится на МСК-сегодня', () => {
    // UTC 2026-06-01 21:30 = МСК 2026-06-02 00:30 → «сегодня» по МСК = 2026-06-02
    const now = new Date('2026-06-01T21:30:00.000Z')
    const result = getTodayCutoffMomentMsk(now, 8, 40)
    expect(result.toISOString()).toBe('2026-06-02T05:40:00.000Z')
  })
})
