import { describe, it, expect } from 'vitest'
import { phantomWeight, isLikelyPhantom, FRONTEND_FIX_DATE_MSK } from './phantom'

describe('phantomWeight — вес достижения цели в пофразной экономике', () => {
  it('дата фикса фронта = 05.07', () => {
    expect(FRONTEND_FIX_DATE_MSK).toBe('2026-07-05')
  })

  it('достижение ПОСЛЕ фикса (или в день фикса) → 1', () => {
    expect(phantomWeight('2026-07-05')).toBe(1)
    expect(phantomWeight('2026-07-06', 'что угодно')).toBe(1)
    expect(phantomWeight('2026-08-01')).toBe(1)
  })

  it('достижение ДО фикса и не конвертер → 0 (фантом)', () => {
    expect(phantomWeight('2026-07-01', 'обед ру')).toBe(0)
    expect(phantomWeight('2026-07-04')).toBe(0)
    expect(isLikelyPhantom('2026-07-01', 'мусорный запрос')).toBe(true)
  })

  it('подтверждённый конвертер ДО фикса → 1 (истина владельца важнее)', () => {
    // «корпоративное питание с доставкой москва» — потерянная 03.07, но реальная.
    expect(phantomWeight('2026-07-03', 'корпоративное питание с доставкой москва')).toBe(1)
    expect(phantomWeight('2026-07-02', 'бизнес ланч доставка москва')).toBe(1)
    expect(isLikelyPhantom('2026-07-01', 'комплексные обеды доставка дубна московская область')).toBe(false)
  })
})
