import { describe, it, expect } from 'vitest'
import { runSanityChecks, type SanityContext } from './sanity-checks'
import type { ParseResult } from './parser'

/**
 * MEGA-1 sanity-checks. weekStartDate — UTC-инстант МСК-полночи понедельника
 * 1 июня 2026 (Пн). Как UTC-точка это 2026-05-31T21:00:00.000Z (МСК = UTC+3).
 * Неделя по МСК-календарю: 2026-06-01 (Пн) … 2026-06-07 (Вс).
 */
const WEEK_START = new Date('2026-05-31T21:00:00.000Z')

const baseContext: SanityContext = {
  expectedDaysPerWeek: 5,
  typicalPortionsPerDay: 20,
  weekStartDate: WEEK_START,
}

function makeParsed(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [
      { date: '2026-06-01', portions: 20 },
      { date: '2026-06-02', portions: 18 },
      { date: '2026-06-03', portions: 22 },
    ],
    dietaryNotes: null,
    confidence: 1,
    reason: 'чёткое фото',
    ...overrides,
  }
}

describe('runSanityChecks', () => {
  it('PASS: полностью валидная заявка → ok=true, нет failures', () => {
    const result = runSanityChecks(makeParsed(), baseContext)
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  // Rule 1: confidence
  it('FAIL rule 1: confidence ниже 0.95', () => {
    const result = runSanityChecks(makeParsed({ confidence: 0.9 }), baseContext)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('confidence'))).toBe(true)
  })

  it('PASS rule 1: confidence ровно 0.95 — граница включена', () => {
    const result = runSanityChecks(makeParsed({ confidence: 0.95 }), baseContext)
    expect(result.failures.some((f) => f.includes('confidence'))).toBe(false)
  })

  // Rule 2: items.length
  it('FAIL rule 2: пустой items', () => {
    const result = runSanityChecks(makeParsed({ items: [] }), baseContext)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('пуст'))).toBe(true)
  })

  it('FAIL rule 2: больше expectedDaysPerWeek+1 дней', () => {
    const result = runSanityChecks(
      makeParsed({
        items: [
          { date: '2026-06-01', portions: 20 },
          { date: '2026-06-02', portions: 20 },
          { date: '2026-06-03', portions: 20 },
          { date: '2026-06-04', portions: 20 },
          { date: '2026-06-05', portions: 20 },
          { date: '2026-06-06', portions: 20 },
          { date: '2026-06-07', portions: 20 },
        ],
      }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('больше ожидаемого'))).toBe(true)
  })

  it('PASS rule 2: ровно expectedDaysPerWeek+1 дней — граница включена', () => {
    const result = runSanityChecks(
      makeParsed({
        items: [
          { date: '2026-06-01', portions: 20 },
          { date: '2026-06-02', portions: 20 },
          { date: '2026-06-03', portions: 20 },
          { date: '2026-06-04', portions: 20 },
          { date: '2026-06-05', portions: 20 },
          { date: '2026-06-06', portions: 20 },
        ],
      }),
      baseContext
    )
    expect(result.failures.some((f) => f.includes('дней'))).toBe(false)
  })

  // Rule 3: portions range
  it('FAIL rule 3: порции выше typical*2.0', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '2026-06-01', portions: 41 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('вне диапазона'))).toBe(true)
  })

  it('FAIL rule 3: порции ниже typical*0.5', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '2026-06-01', portions: 9 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('вне диапазона'))).toBe(true)
  })

  it('PASS rule 3: порции ровно на границах [10, 40] включительно', () => {
    const result = runSanityChecks(
      makeParsed({
        items: [
          { date: '2026-06-01', portions: 10 },
          { date: '2026-06-02', portions: 40 },
        ],
      }),
      baseContext
    )
    expect(result.failures.some((f) => f.includes('вне диапазона'))).toBe(false)
  })

  // Rule 4: valid YYYY-MM-DD
  it('FAIL rule 4: невалидный формат даты', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '01.06.2026', portions: 20 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('невалидная дата'))).toBe(true)
  })

  it('FAIL rule 4: несуществующая календарная дата (30 февраля)', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '2026-02-30', portions: 20 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('невалидная дата'))).toBe(true)
  })

  // Rule 5: date within week
  it('FAIL rule 5: дата раньше понедельника недели', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '2026-05-31', portions: 20 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('вне недели'))).toBe(true)
  })

  it('FAIL rule 5: дата позже воскресенья недели', () => {
    const result = runSanityChecks(
      makeParsed({ items: [{ date: '2026-06-08', portions: 20 }] }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('вне недели'))).toBe(true)
  })

  it('PASS rule 5: крайние дни недели (Пн и Вс) внутри диапазона', () => {
    const result = runSanityChecks(
      makeParsed({
        items: [
          { date: '2026-06-01', portions: 20 },
          { date: '2026-06-07', portions: 20 },
        ],
      }),
      baseContext
    )
    expect(result.failures.some((f) => f.includes('вне недели'))).toBe(false)
  })

  // Rule 6: no duplicate dates
  it('FAIL rule 6: дубликат даты', () => {
    const result = runSanityChecks(
      makeParsed({
        items: [
          { date: '2026-06-01', portions: 20 },
          { date: '2026-06-01', portions: 18 },
        ],
      }),
      baseContext
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.includes('дубликат'))).toBe(true)
  })

  it('PASS rule 6: все даты уникальны → нет жалобы на дубликаты', () => {
    const result = runSanityChecks(makeParsed(), baseContext)
    expect(result.failures.some((f) => f.includes('дубликат'))).toBe(false)
  })
})
