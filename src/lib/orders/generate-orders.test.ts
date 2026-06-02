import { describe, it, expect } from 'vitest'
import { resolveTargetDate, planConfigDeliveryDates } from './generate-orders'
import type { ClientMealConfig } from '@prisma/client'

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

/**
 * 7.41: planConfigDeliveryDates — чистое планирование дат на горизонт `days`.
 *
 * Опорный момент: МСК-сегодня = вс 2026-06-07 (now = 12:00 МСК). Тогда диапазон
 * offset 1..7 = пн 08 .. вс 14 июня 2026:
 *   08 Пн, 09 Вт, 10 Ср, 11 Чт, 12 Пт, 13 Сб, 14 Вс.
 * (2026-06-01 — понедельник; getMskCalendarDayUtc даёт UTC-полночь @db.Date.)
 *
 * NB: isScheduledForDate использует date.getDay() (локальный) — корректно для
 * UTC/МСК-раннеров (UTC-полночь +0/+3ч остаётся тем же календарным днём).
 */
describe('planConfigDeliveryDates (7.41 range)', () => {
  // вс 2026-06-07 12:00 МСК → offset 1 = пн 2026-06-08.
  const now = new Date('2026-06-07T09:00:00.000Z')
  const DAYS = 7

  const cfg = (over: Partial<ClientMealConfig>): ClientMealConfig =>
    ({
      scheduleType: 'DAILY',
      scheduleData: null,
      validFrom: null,
      validTo: null,
      ...over,
    }) as ClientMealConfig

  const isoDates = (dates: Date[]) => dates.map((d) => d.toISOString().slice(0, 10))

  it('WEEKDAYS на 7 дней → 5 заказов (пн-пт), пропускает сб/вс', () => {
    const dates = planConfigDeliveryDates(cfg({ scheduleType: 'WEEKDAYS' }), false, now, DAYS)
    expect(isoDates(dates)).toEqual([
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12',
    ])
  })

  it('DAILY на 7 дней → 7 заказов (весь диапазон offset 1..7)', () => {
    const dates = planConfigDeliveryDates(cfg({ scheduleType: 'DAILY' }), false, now, DAYS)
    expect(isoDates(dates)).toEqual([
      '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14',
    ])
  })

  it('same-day конфиг → НЕ входит в диапазон, ровно [сегодня] (offset 0)', () => {
    const dates = planConfigDeliveryDates(cfg({ scheduleType: 'DAILY' }), true, now, DAYS)
    expect(isoDates(dates)).toEqual(['2026-06-07']) // только сегодня МСК
    expect(dates).toHaveLength(1)
  })

  it('идемпотентность планирования: два вызова дают идентичный результат', () => {
    const config = cfg({ scheduleType: 'WEEKDAYS' })
    const first = planConfigDeliveryDates(config, false, now, DAYS)
    const second = planConfigDeliveryDates(config, false, now, DAYS)
    expect(isoDates(first)).toEqual(isoDates(second))
  })

  it('ONE_TIME с validFrom в середине диапазона → ровно 1 заказ в этот день', () => {
    const dates = planConfigDeliveryDates(
      cfg({ scheduleType: 'ONE_TIME', validFrom: new Date('2026-06-11T00:00:00.000Z') }),
      false, now, DAYS,
    )
    expect(isoDates(dates)).toEqual(['2026-06-11'])
  })

  it('CUSTOM_DAYS [1,3,5] (пн/ср/пт) → 3 заказа из 7', () => {
    const dates = planConfigDeliveryDates(
      cfg({ scheduleType: 'CUSTOM_DAYS', scheduleData: { daysOfWeek: [1, 3, 5] } }),
      false, now, DAYS,
    )
    expect(isoDates(dates)).toEqual(['2026-06-08', '2026-06-10', '2026-06-12'])
  })
})
