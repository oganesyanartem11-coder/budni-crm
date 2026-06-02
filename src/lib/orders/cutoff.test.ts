import { describe, it, expect } from 'vitest'
import {
  getCutoffMoment,
  getTodayCutoffMomentMsk,
  getCutoffCountdown,
  getCountdownToMoment,
  formatMskTime,
} from './cutoff'

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

  // 7.40: sameDay-ветка — cut-off на САМОЙ deliveryDate, без вычитания дня.
  it('sameDay=true: 8:40 МСК (=05:40 UTC) на САМ deliveryDate (не день перед)', () => {
    const deliveryDate = new Date('2026-06-02T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate, 8, 40, true)
    expect(result.toISOString()).toBe('2026-06-02T05:40:00.000Z')
  })

  it('sameDay=false (явно): эквивалентно легаси — день перед', () => {
    const deliveryDate = new Date('2026-06-02T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate, 8, 40, false)
    expect(result.toISOString()).toBe('2026-06-01T05:40:00.000Z')
  })

  it('sameDay + граница месяца: deliveryDate=1 числа → cut-off в тот же 1-й день', () => {
    const deliveryDate = new Date('2026-07-01T00:00:00.000Z')
    const result = getCutoffMoment(deliveryDate, 8, 40, true)
    expect(result.toISOString()).toBe('2026-07-01T05:40:00.000Z')
  })
})

describe('getCutoffCountdown (легаси, обратная совместимость)', () => {
  it('без deliveryDate → сегодня 16:00 МСК; отсчёт от now', () => {
    const now = new Date('2026-06-01T09:00:00.000Z') // МСК 12:00, cut-off сегодня 13:00 UTC
    const r = getCutoffCountdown(undefined, now)
    expect(r.isPast).toBe(false)
    expect(r.isToday).toBe(true)
    expect(r.hoursLeft).toBe(4)
    expect(r.minutesLeft).toBe(0)
    expect(r.totalMinutesLeft).toBe(240)
  })

  it('после cut-off → isPast=true, часы/минуты клампятся к 0', () => {
    const now = new Date('2026-06-01T14:00:00.000Z') // МСК 17:00, cut-off 13:00 UTC прошёл
    const r = getCutoffCountdown(undefined, now)
    expect(r.isPast).toBe(true)
    expect(r.hoursLeft).toBe(0)
    expect(r.minutesLeft).toBe(0)
    expect(r.totalMinutesLeft).toBeLessThan(0)
  })

  it('с deliveryDate → cut-off дня перед, 16:00 МСК (как раньше)', () => {
    const now = new Date('2026-06-01T09:00:00.000Z')
    const deliveryDate = new Date('2026-06-02T00:00:00.000Z') // cut-off 2026-06-01 13:00 UTC
    const r = getCutoffCountdown(deliveryDate, now)
    expect(r.isPast).toBe(false)
    expect(r.hoursLeft).toBe(4)
  })
})

describe('getCountdownToMoment (7.40)', () => {
  it('отсчёт до явного момента', () => {
    const now = new Date('2026-06-02T03:00:00.000Z') // МСК 06:00
    const target = new Date('2026-06-02T05:40:00.000Z') // МСК 08:40 (sameDay cut-off)
    const r = getCountdownToMoment(target, now)
    expect(r.isPast).toBe(false)
    expect(r.hoursLeft).toBe(2)
    expect(r.minutesLeft).toBe(40)
    expect(r.totalMinutesLeft).toBe(160)
    expect(r.isToday).toBe(true)
  })

  it('момент в прошлом → isPast=true', () => {
    const now = new Date('2026-06-02T06:00:00.000Z') // МСК 09:00
    const target = new Date('2026-06-02T05:40:00.000Z') // МСК 08:40 прошёл
    const r = getCountdownToMoment(target, now)
    expect(r.isPast).toBe(true)
    expect(r.hoursLeft).toBe(0)
  })
})

describe('formatMskTime (7.40)', () => {
  it('форматирует UTC-момент в HH:MM по МСК (UTC+3)', () => {
    expect(formatMskTime(new Date('2026-06-02T05:40:00.000Z'))).toBe('08:40')
    expect(formatMskTime(new Date('2026-06-01T13:00:00.000Z'))).toBe('16:00')
  })

  it('полночь МСК и переход суток', () => {
    expect(formatMskTime(new Date('2026-06-01T21:00:00.000Z'))).toBe('00:00') // МСК 00:00 след. суток
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
