import { describe, it, expect } from 'vitest'
import { dayBounds } from './dashboard-hero'

/**
 * 7.42: dayBounds — границы суток для запроса по deliveryDate (@db.Date).
 *
 * Контракт: возвращает UTC-полночь МСК-календарного дня base и следующего дня
 * ([start, end)). UTC-дата start/end = нужный МСК-день, чтобы Prisma при усечении
 * @db.Date-границы не уехала на сутки назад (корневой баг hero «сегодня = вчера»).
 * МСК = UTC+3 (DST не действует с 2011). Тесты не зависят от TZ раннера —
 * используем фиксированные UTC-инстансты.
 */
describe('dayBounds (dashboard-hero)', () => {
  it('возвращает UTC-полночь МСК-дня для now', () => {
    const now = new Date('2026-06-02T07:00:00.000Z') // 10:00 МСК
    const { start, end } = dayBounds(now)
    expect(start.toISOString()).toBe('2026-06-02T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-06-03T00:00:00.000Z')
  })

  it('корректно работает на границе полуночи МСК (00:30 МСК = 21:30 UTC вчера)', () => {
    // Jun2 00:30 МСК = Jun1 21:30 UTC — UTC-дата «вчера», но МСК-день уже Jun2.
    const now = new Date('2026-06-01T21:30:00.000Z')
    const { start, end } = dayBounds(now)
    expect(start.toISOString()).toBe('2026-06-02T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-06-03T00:00:00.000Z')
  })

  it('addDays(-7) даёт неделю назад (МСК) — для WoW-сравнения', () => {
    const now = new Date('2026-06-02T07:00:00.000Z')
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const { start, end } = dayBounds(weekAgo)
    expect(start.toISOString()).toBe('2026-05-26T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-05-27T00:00:00.000Z')
  })

  it('граница месяца — week ago пересекает 1 июня → May25', () => {
    const now = new Date('2026-06-01T15:00:00.000Z') // 18:00 МСК
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) // May25 15:00 UTC = 18:00 МСК
    const { start } = dayBounds(weekAgo)
    expect(start.toISOString()).toBe('2026-05-25T00:00:00.000Z')
  })
})
