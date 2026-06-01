import { describe, it, expect } from 'vitest'
import { getMskCalendarDayUtc } from './msk-window'

/**
 * Регрессионные тесты для Bug 7.25 (UTC off-by-one в окне 00:00-03:00 МСК).
 * Helper возвращает UTC-полночь МСК-календарного дня + offsetDays — формат @db.Date.
 * Тесты передают фиксированный UTC-инстант, чтобы не зависеть от системного времени.
 */
describe('getMskCalendarDayUtc', () => {
  it('00:31 МСК (UTC ещё «вчера»): offsetDays=1 даёт МСК-завтра — Bug 7.25', () => {
    // UTC 2026-05-31 21:31 = МСК 2026-06-01 00:31. Старый код дал бы 2026-06-01 (=сегодня по UTC).
    const now = new Date('2026-05-31T21:31:00.000Z')
    const result = getMskCalendarDayUtc(now, 1)
    expect(result.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })

  it('обычный день (МСК 12:00): offsetDays=0 даёт МСК-сегодня', () => {
    const now = new Date('2026-06-01T09:00:00.000Z') // МСК 12:00
    const result = getMskCalendarDayUtc(now, 0)
    expect(result.toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('02:59 МСК (граница UTC-вчера): offsetDays=0 даёт МСК-сегодня', () => {
    const now = new Date('2026-05-31T23:59:00.000Z') // МСК 2026-06-01 02:59
    const result = getMskCalendarDayUtc(now, 0)
    expect(result.toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('03:00 МСК (граница UTC-сегодня): результат идентичен 02:59 МСК', () => {
    const now = new Date('2026-06-01T00:00:00.000Z') // МСК 03:00
    const result = getMskCalendarDayUtc(now, 0)
    expect(result.toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('окно 00:00-03:00 МСК: offsetDays=1 корректно переходит через границу месяца', () => {
    const now = new Date('2026-05-31T22:00:00.000Z') // МСК 2026-06-01 01:00
    const result = getMskCalendarDayUtc(now, 1)
    expect(result.toISOString()).toBe('2026-06-02T00:00:00.000Z')
  })

  it('окно 00:00-03:00 МСК: offsetDays=0 корректно переходит через границу года', () => {
    const now = new Date('2026-12-31T22:00:00.000Z') // МСК 2027-01-01 01:00
    const result = getMskCalendarDayUtc(now, 0)
    expect(result.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('offsetDays=-1 даёт МСК-вчера', () => {
    const now = new Date('2026-06-01T09:00:00.000Z') // МСК 12:00
    const result = getMskCalendarDayUtc(now, -1)
    expect(result.toISOString()).toBe('2026-05-31T00:00:00.000Z')
  })

  it('29 февраля високосного года: offsetDays=0 даёт 29 фев, offsetDays=1 даёт 1 марта', () => {
    const now = new Date('2028-02-28T22:00:00.000Z') // МСК 2028-02-29 01:00 (2028 — високосный)
    expect(getMskCalendarDayUtc(now, 0).toISOString()).toBe('2028-02-29T00:00:00.000Z')
    expect(getMskCalendarDayUtc(now, 1).toISOString()).toBe('2028-03-01T00:00:00.000Z')
  })

  it('без аргументов: возвращает UTC-полночь (часы/минуты/секунды/ms = 0)', () => {
    const result = getMskCalendarDayUtc()
    expect(result.getUTCHours()).toBe(0)
    expect(result.getUTCMinutes()).toBe(0)
    expect(result.getUTCSeconds()).toBe(0)
    expect(result.getUTCMilliseconds()).toBe(0)
  })
})
