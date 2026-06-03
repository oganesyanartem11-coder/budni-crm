import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPresetRange } from './week'

/**
 * Sprint 7.46: дашбордные rolling-окна week_to_date / month_rolling / last_3_months.
 * Все границы в МСК (UTC+3 без DST). Ожидаемые UTC-инстанты:
 *   00:00 МСК даты X  = (X−1)T21:00:00.000Z
 *   23:59:59.999 МСК  = XT20:59:59.999Z
 *
 * Фиксируем «сейчас» через vi.setSystemTime — getPresetRange внутри зовёт
 * new Date() для новых кейсов, fake timers делают их детерминированными.
 */

function freeze(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

beforeEach(() => {
  // База: среда 3 июня 2026, 12:00 МСК = 09:00 UTC.
  freeze('2026-06-03T09:00:00.000Z')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getPresetRange — новые rolling-ключи на 2026-06-03 12:00 МСК', () => {
  it('week_to_date: Сб 30 мая 00:00 МСК → Ср 3 июня 23:59:59.999 МСК', () => {
    const { from, to } = getPresetRange('week_to_date')
    expect(from.toISOString()).toBe('2026-05-29T21:00:00.000Z') // 30 мая 00:00 МСК
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z') // 3 июня 23:59:59.999 МСК
  })

  it('month_rolling: 3 мая 00:00 МСК → 3 июня 23:59:59.999 МСК', () => {
    const { from, to } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-05-02T21:00:00.000Z') // 3 мая 00:00 МСК
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z')
  })

  it('last_3_months: 3 марта 00:00 МСК → 3 июня 23:59:59.999 МСК', () => {
    const { from, to } = getPresetRange('last_3_months')
    expect(from.toISOString()).toBe('2026-03-02T21:00:00.000Z') // 3 марта 00:00 МСК
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z')
  })
})

describe('getPresetRange — month_rolling clamp граничных дней (2026 не високосный)', () => {
  it('31 марта 2026 − 1 мес → 28 февраля 2026 (не 3 марта overflow)', () => {
    freeze('2026-03-31T09:00:00.000Z') // 31 марта 12:00 МСК
    const { from } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-02-27T21:00:00.000Z') // 28 фев 00:00 МСК
  })

  it('1 марта 2026 − 1 мес → 1 февраля 2026', () => {
    freeze('2026-03-01T09:00:00.000Z') // 1 марта 12:00 МСК
    const { from } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-01-31T21:00:00.000Z') // 1 фев 00:00 МСК
  })
})

describe('getPresetRange — last_3_months clamp', () => {
  it('31 мая 2026 − 3 мес → 28 февраля 2026 (clamp на февраль)', () => {
    freeze('2026-05-31T09:00:00.000Z') // 31 мая 12:00 МСК
    const { from } = getPresetRange('last_3_months')
    expect(from.toISOString()).toBe('2026-02-27T21:00:00.000Z') // 28 фев 00:00 МСК
  })
})

describe('getPresetRange — sanity: to не в будущем для всех новых ключей', () => {
  const keys = ['week_to_date', 'month_rolling', 'last_3_months'] as const
  // Конец сегодняшнего МСК-дня на 2026-06-03 12:00 МСК.
  const endOfTodayMsk = new Date('2026-06-03T20:59:59.999Z').getTime()

  it.each(keys)('%s: to === конец сегодняшнего МСК-дня и from < to', (key) => {
    const { from, to } = getPresetRange(key)
    expect(to.getTime()).toBe(endOfTodayMsk)
    expect(from.getTime()).toBeLessThan(to.getTime())
  })
})
