import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPresetRange, getFinancialWeekForDbDate, toDbDateRange, countDbDays } from './week'

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
 *   - ВСЕ календарные пресеты (today/yesterday/this_week/last_week/месяцы/
 *     кварталы/год/custom) теперь тоже: from = UTC-полночь первого МСК-дня,
 *     to = МСК 23:59:59.999 последнего дня (XT20:59:59.999Z).
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

/**
 * Аудит дат 18.10: календарные пресеты считались от серверного UTC
 * now.setHours(0,0,0,0) → в 00:00–03:00 МСК «сегодня» = вчера; this_week.from
 * был МСК-инстантом Пт 21:00Z → для @db.Date неделя Пт–Пт (8 дней).
 */
describe('getPresetRange — календарные пресеты в МСК (ночь 00:00–03:00 и день)', () => {
  it('Пн 19.10 01:30 МСК (18.10 22:30Z): today = 19.10', () => {
    freeze('2026-10-18T22:30:00.000Z')
    const { from, to } = getPresetRange('today')
    expect(from.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    // Было 2026-10-19T23:59:59.999Z (= 20.10 02:59 МСК) — material-cost считал 2 дня.
    expect(to.toISOString()).toBe('2026-10-19T20:59:59.999Z')
  })

  it('Пн 19.10 01:30 МСК: yesterday = 18.10', () => {
    freeze('2026-10-18T22:30:00.000Z')
    const { from, to } = getPresetRange('yesterday')
    expect(from.toISOString()).toBe('2026-10-18T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-18T20:59:59.999Z')
  })

  it('Пн 19.10 01:30 МСК: this_week = Сб 17.10 → Пт 23.10 (from — UTC-полночь субботы, не Пт 21:00Z)', () => {
    freeze('2026-10-18T22:30:00.000Z')
    const { from, to } = getPresetRange('this_week')
    expect(from.toISOString()).toBe('2026-10-17T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-23T20:59:59.999Z')
    expect(countDbDays(toDbDateRange(from, to))).toBe(7)
  })

  it('Пн 19.10 01:30 МСК: last_week = Сб 10.10 → Пт 16.10', () => {
    freeze('2026-10-18T22:30:00.000Z')
    const { from, to } = getPresetRange('last_week')
    expect(from.toISOString()).toBe('2026-10-10T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-16T20:59:59.999Z')
  })

  it('Сб 24.10 01:30 МСК (23.10 22:30Z): this_week уже НОВАЯ неделя 24.10 → 30.10', () => {
    // Старый код: setHours(0) по UTC → Пт 23.10 → прошлая неделя.
    freeze('2026-10-23T22:30:00.000Z')
    const { from, to } = getPresetRange('this_week')
    expect(from.toISOString()).toBe('2026-10-24T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-30T20:59:59.999Z')
  })

  it('днём Вс 18.10 12:00 МСК: this_week = Сб 17.10 → Пт 23.10', () => {
    freeze('2026-10-18T09:00:00.000Z')
    const { from, to } = getPresetRange('this_week')
    expect(from.toISOString()).toBe('2026-10-17T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-23T20:59:59.999Z')
  })

  it('Вс 1.11 01:30 МСК (31.10 22:30Z): this_month = ноябрь, last_month = октябрь', () => {
    freeze('2026-10-31T22:30:00.000Z')
    const tm = getPresetRange('this_month')
    expect(tm.from.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(tm.to.toISOString()).toBe('2026-11-01T20:59:59.999Z')
    const lm = getPresetRange('last_month')
    expect(lm.from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(lm.to.toISOString()).toBe('2026-10-31T20:59:59.999Z')
  })

  it('днём 18.10: this_month / this_quarter / last_quarter / this_year', () => {
    freeze('2026-10-18T09:00:00.000Z')
    expect(getPresetRange('this_month').from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(getPresetRange('this_month').to.toISOString()).toBe('2026-10-18T20:59:59.999Z')
    expect(getPresetRange('this_quarter').from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    const lq = getPresetRange('last_quarter')
    expect(lq.from.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(lq.to.toISOString()).toBe('2026-09-30T20:59:59.999Z')
    expect(getPresetRange('this_year').from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('1.01.2026 01:30 МСК (31.12.2025 22:30Z): год/квартал/месяц уже 2026, прошлые — 2025', () => {
    freeze('2025-12-31T22:30:00.000Z')
    expect(getPresetRange('this_year').from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(getPresetRange('this_year').to.toISOString()).toBe('2026-01-01T20:59:59.999Z')
    const lm = getPresetRange('last_month')
    expect(lm.from.toISOString()).toBe('2025-12-01T00:00:00.000Z')
    expect(lm.to.toISOString()).toBe('2025-12-31T20:59:59.999Z')
    const lq = getPresetRange('last_quarter')
    expect(lq.from.toISOString()).toBe('2025-10-01T00:00:00.000Z')
    expect(lq.to.toISOString()).toBe('2025-12-31T20:59:59.999Z')
  })

  it("custom 'YYYY-MM-DD' — календарные дни как есть; пустой → МСК-сегодня", () => {
    freeze('2026-10-18T22:30:00.000Z')
    const c = getPresetRange('custom', '2026-10-01', '2026-10-05')
    expect(c.from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(c.to.toISOString()).toBe('2026-10-05T20:59:59.999Z')
    const d = getPresetRange('custom')
    expect(d.from.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(d.to.toISOString()).toBe('2026-10-19T20:59:59.999Z')
  })
})

describe('toDbDateRange — включительные МСК-дни → half-open UTC-полночи', () => {
  const D19 = '2026-10-19T00:00:00.000Z'
  const D20 = '2026-10-20T00:00:00.000Z'
  it.each([
    ['UTC-полночь', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    ['МСК-инстант полуночи / МСК 23:59:59.999', '2026-10-18T21:00:00.000Z', '2026-10-19T20:59:59.999Z'],
    ['момент «сейчас» 01:30 МСК', '2026-10-18T22:30:00.000Z', '2026-10-18T22:30:00.000Z'],
  ])('%s → { gte: 19.10, lt: 20.10 }', (_name, f, t) => {
    const r = toDbDateRange(new Date(f), new Date(t))
    expect(r.gte.toISOString()).toBe(D19)
    expect(r.lt.toISOString()).toBe(D20)
    expect(countDbDays(r)).toBe(1)
  })

  it('to раньше from → пустой диапазон', () => {
    const r = toDbDateRange(new Date('2026-10-20T00:00:00.000Z'), new Date('2026-10-18T00:00:00.000Z'))
    expect(countDbDays(r)).toBe(0)
  })
})
