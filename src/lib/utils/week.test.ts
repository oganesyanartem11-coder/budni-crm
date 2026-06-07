import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPresetRange, getFinancialWeekForDbDate } from './week'

/**
 * Sprint 7.46: дашбордные rolling-окна week_to_date / month_rolling / last_3_months.
 * Все границы в МСК (UTC+3 без DST). Ожидаемые UTC-инстанты:
 *   00:00 МСК даты X  = (X−1)T21:00:00.000Z
 *   23:59:59.999 МСК  = XT20:59:59.999Z
 *
 * ВНИМАНИЕ к `from` (после fix «Два midnight»): для @db.Date Order.deliveryDate
 * нужна UTC-полночь МСК-дня (XT00:00:00.000Z), а не UTC-инстант МСК-полночи
 * ((X−1)T21:00:00.000Z) — иначе Prisma усекает инстант до даты пред.дня.
 *   - month_rolling / last_3_months / week_to_date: from = UTC-полночь МСК-дня
 *     (XT00:00:00.000Z). week_to_date через getFinancialWeekForDbDate (V-15.2).
 *   - this_week / last_week: from пока МСК-инстант через getFinancialWeek
 *     (load-bearing; their @db.Date consumers — отдельный заход V-15.2.thisweek).
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
    expect(from.toISOString()).toBe('2026-05-30T00:00:00.000Z') // 30 мая 00:00 МСК (UTC-полночь МСК-дня)
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z') // 3 июня 23:59:59.999 МСК
  })

  it('month_rolling: 3 мая 00:00 МСК → 3 июня 23:59:59.999 МСК', () => {
    const { from, to } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-05-03T00:00:00.000Z') // 3 мая 00:00 МСК (UTC-полночь МСК-дня)
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z')
  })

  it('last_3_months: 3 марта 00:00 МСК → 3 июня 23:59:59.999 МСК', () => {
    const { from, to } = getPresetRange('last_3_months')
    expect(from.toISOString()).toBe('2026-03-03T00:00:00.000Z') // 3 марта 00:00 МСК (UTC-полночь МСК-дня)
    expect(to.toISOString()).toBe('2026-06-03T20:59:59.999Z')
  })
})

/**
 * V-15.2: фикс «Нед» на проде 7 июня — показывала лишнюю пятницу прошлой фин-недели
 * (165 950₽ = Пт 5.06 + Сб 6.06 + Вс 7.06 вместо 73 800₽). from должен быть
 * UTC-полночь МСК-субботы, не МСК-инстант (Пт 21:00Z).
 */
describe('getFinancialWeekForDbDate (V-15.2 «Два midnight»)', () => {
  it('Вс 7 июня 17:39 МСК → from = UTC-полночь МСК-субботы 6 июня', () => {
    // 2026-06-07T14:39:51Z = Вс 7 июня 17:39 МСК; фин-неделя Сб 6.06 → Пт 12.06.
    const { from } = getFinancialWeekForDbDate(new Date('2026-06-07T14:39:51.000Z'))
    expect(from.toISOString()).toBe('2026-06-06T00:00:00.000Z') // НЕ 2026-06-05T21:00:00.000Z
  })

  it('getPresetRange(week_to_date) на Вс 7 июня → from = Сб 6.06 00:00 UTC (без лишней пятницы)', () => {
    freeze('2026-06-07T14:39:51.000Z') // Вс 7 июня 17:39 МСК
    const { from, to } = getPresetRange('week_to_date')
    expect(from.toISOString()).toBe('2026-06-06T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-06-07T20:59:59.999Z') // конец Вс 7.06 МСК
  })
})

describe('getPresetRange — month_rolling clamp граничных дней (2026 не високосный)', () => {
  it('31 марта 2026 − 1 мес → 28 февраля 2026 (не 3 марта overflow)', () => {
    freeze('2026-03-31T09:00:00.000Z') // 31 марта 12:00 МСК
    const { from } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-02-28T00:00:00.000Z') // 28 фев 00:00 МСК (UTC-полночь МСК-дня)
  })

  it('1 марта 2026 − 1 мес → 1 февраля 2026', () => {
    freeze('2026-03-01T09:00:00.000Z') // 1 марта 12:00 МСК
    const { from } = getPresetRange('month_rolling')
    expect(from.toISOString()).toBe('2026-02-01T00:00:00.000Z') // 1 фев 00:00 МСК (UTC-полночь МСК-дня)
  })
})

describe('getPresetRange — last_3_months clamp', () => {
  it('31 мая 2026 − 3 мес → 28 февраля 2026 (clamp на февраль)', () => {
    freeze('2026-05-31T09:00:00.000Z') // 31 мая 12:00 МСК
    const { from } = getPresetRange('last_3_months')
    expect(from.toISOString()).toBe('2026-02-28T00:00:00.000Z') // 28 фев 00:00 МСК (UTC-полночь МСК-дня)
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
