import { describe, it, expect, vi } from 'vitest'
import {
  isWorkday,
  workdayWindowStartUtc,
  addWorkdaysUtc,
  RU_HOLIDAYS_2026,
} from './workdays'

describe('isWorkday (производственный календарь РФ 2026)', () => {
  it('будни — рабочие', () => {
    expect(isWorkday('2026-07-06')).toBe(true) // понедельник
    expect(isWorkday('2026-07-10')).toBe(true) // пятница
  })
  it('выходные — нерабочие', () => {
    expect(isWorkday('2026-07-11')).toBe(false) // суббота
    expect(isWorkday('2026-07-12')).toBe(false) // воскресенье
  })
  it('праздники РФ 2026 — нерабочие (даже если будни)', () => {
    expect(isWorkday('2026-06-12')).toBe(false) // День России (пятница)
    expect(isWorkday('2026-11-04')).toBe(false) // День единства (среда)
    expect(isWorkday('2026-01-07')).toBe(false) // новогодние
    expect(isWorkday('2026-05-11')).toBe(false) // перенос Дня Победы
    expect(RU_HOLIDAYS_2026.has('2026-06-12')).toBe(true)
  })
  it('дата вне известного календаря → фолбэк на выходные + warn (не падает)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isWorkday('2027-03-16')).toBe(true) // понедельник 2027 — рабочий по фолбэку
    expect(isWorkday('2027-03-14')).toBe(false) // суббота 2027
    warn.mockRestore()
  })
})

describe('workdayWindowStartUtc — старт окна из N рабочих дней назад', () => {
  const day = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10)

  it('10 рабочих дней назад от пятницы 10.07 → перешагивает выходные', () => {
    // 10 рабочих дней назад включительно от Пт 10.07: 10,9,8,7,6(Пн) = 5; затем через
    // выходные 4-5 к Пт 3, Чт 2, Ср 1, Вт 30.06, Пн 29.06 = ещё 5 → старт 29.06.
    const start = workdayWindowStartUtc('2026-07-10', 10)
    expect(day(start)).toBe('2026-06-29')
  })
  it('конец окна в выходной → включает его, считает рабочие назад', () => {
    // Вс 12.07: 0 рабочих, шаг к Пт 10 (1)…до 5 рабочих → Пн 06.07.
    const start = workdayWindowStartUtc('2026-07-12', 5)
    expect(day(start)).toBe('2026-07-06')
  })
  it('окно перешагивает праздник (12.06 нерабочий)', () => {
    // 3 рабочих назад от Пн 15.06: 15,11(через вс/сб 13-14),10 — 12.06 праздник пропущен.
    const start = workdayWindowStartUtc('2026-06-15', 3)
    expect(day(start)).toBe('2026-06-10')
  })
})

describe('addWorkdaysUtc — конец окна вперёд на N рабочих дней', () => {
  const day = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10)
  it('7 рабочих дней вперёд от Пн 06.07 перешагивает выходные', () => {
    // 06(1),07,08,09,10(5) выходные 11-12, 13(6),14(7) → 14.07.
    expect(day(addWorkdaysUtc('2026-07-06', 7))).toBe('2026-07-14')
  })
})
