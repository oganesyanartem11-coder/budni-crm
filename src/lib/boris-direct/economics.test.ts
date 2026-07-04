import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  isProtectedConverter,
  filterOutProtectedConverters,
  cplPctOfValue,
  cplBelowValue,
  formatCplWithValue,
  CONVERTER_PROTECT_WINDOW_DAYS,
} from './economics'

afterEach(() => vi.unstubAllEnvs())

describe('защита конвертеров (окно 30 дней)', () => {
  it('окно защиты — 30 дней', () => {
    expect(CONVERTER_PROTECT_WINDOW_DAYS).toBe(30)
  })

  it('≥1 заявка за 30д → защищён; 0 → нет', () => {
    expect(isProtectedConverter(1)).toBe(true)
    expect(isProtectedConverter(5)).toBe(true)
    expect(isProtectedConverter(0)).toBe(false)
  })

  it('ДОРОГОЙ конвертер НЕ попадает в кандидаты отключения; дешёвый пустой объём — попадает', () => {
    const candidates = ['дорогой конвертер москва', 'пустой объём без заявок']
    // «дорогой конвертер» дал 2 заявки за 30д (пусть дорого) — защищён;
    // «пустой объём» — 0 заявок за 30д — кандидат остаётся.
    const conv30d: Record<string, number> = {
      'дорогой конвертер москва': 2,
      'пустой объём без заявок': 0,
    }
    const { kept, protectedConverters } = filterOutProtectedConverters(
      candidates,
      (c) => conv30d[c] ?? 0
    )
    expect(kept).toEqual(['пустой объём без заявок'])
    expect(protectedConverters).toEqual(['дорогой конвертер москва'])
  })

  it('конвертер, у которого в узком окне 0 заявок, но есть за 30д — защищён', () => {
    const { kept, protectedConverters } = filterOutProtectedConverters(
      ['фраза'],
      () => 1 // 1 заявка за 30д (в 14д окне минуса могло быть 0)
    )
    expect(kept).toEqual([])
    expect(protectedConverters).toEqual(['фраза'])
  })
})

describe('цена заявки в % от ценности (LEAD_VALUE_RUB)', () => {
  it('дефолт ценности 20000: CPL 900 = 4.5%', () => {
    expect(cplPctOfValue(900)).toBeCloseTo(4.5, 5)
    expect(formatCplWithValue(900)).toBe('900 ₽ (4,5% ценности заявки)')
  })

  it('CPL < ценности → below=true (нет паники); ≥ ценности → false', () => {
    expect(cplBelowValue(900)).toBe(true)
    expect(cplBelowValue(19999)).toBe(true)
    expect(cplBelowValue(20000)).toBe(false)
    expect(cplBelowValue(25000)).toBe(false)
  })

  it('env BORIS_DIRECT_LEAD_VALUE_RUB переопределяет ценность', () => {
    vi.stubEnv('BORIS_DIRECT_LEAD_VALUE_RUB', '10000')
    expect(cplPctOfValue(900)).toBeCloseTo(9, 5)
    expect(formatCplWithValue(900)).toBe('900 ₽ (9,0% ценности заявки)')
  })

  it('null CPL → «нет данных», проценты null', () => {
    expect(cplPctOfValue(null)).toBeNull()
    expect(formatCplWithValue(null)).toBe('нет данных')
    expect(cplBelowValue(null)).toBe(false)
  })
})
