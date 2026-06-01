import { describe, it, expect } from 'vitest'
import { resolveTargetDate } from './generate-orders'

/**
 * 7.39: same-day delivery — дата заказа определяется per-config.
 * resolveTargetDate — чистая функция (без БД), тестируется напрямую.
 *
 * Контракт:
 *  - location.sameDayDelivery === true  → today (сегодня МСК)
 *  - location.sameDayDelivery === false → defaultDate (обычно завтра МСК)
 */
describe('resolveTargetDate (7.39 same-day)', () => {
  const today = new Date('2026-06-01T00:00:00.000Z')
  const tomorrow = new Date('2026-06-02T00:00:00.000Z')

  it('same-day локация → дата = сегодня (МСК)', () => {
    const config = { location: { sameDayDelivery: true } }
    expect(resolveTargetDate(config, tomorrow, today).toISOString()).toBe(today.toISOString())
  })

  it('обычная локация → дата = переданная defaultDate (завтра), как раньше', () => {
    const config = { location: { sameDayDelivery: false } }
    expect(resolveTargetDate(config, tomorrow, today).toISOString()).toBe(tomorrow.toISOString())
  })

  it('смешанный список: у каждого конфига своя дата', () => {
    const configs = [
      { id: 'a', location: { sameDayDelivery: true } },
      { id: 'b', location: { sameDayDelivery: false } },
      { id: 'c', location: { sameDayDelivery: true } },
    ]
    const resolved = configs.map((c) => resolveTargetDate(c, tomorrow, today).toISOString())
    expect(resolved).toEqual([
      today.toISOString(), // a — same-day
      tomorrow.toISOString(), // b — обычный
      today.toISOString(), // c — same-day
    ])
  })

  it('today и defaultDate совпадают → обе ветки дают одну дату', () => {
    const sameDay = { location: { sameDayDelivery: true } }
    const normal = { location: { sameDayDelivery: false } }
    expect(resolveTargetDate(sameDay, today, today).toISOString()).toBe(today.toISOString())
    expect(resolveTargetDate(normal, today, today).toISOString()).toBe(today.toISOString())
  })
})
