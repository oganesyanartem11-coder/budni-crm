import { describe, it, expect } from 'vitest'
import { formatDateRangeRu } from './format'

/**
 * formatDateRangeRu рендерит МСК-календарный диапазон. Все компоненты дат
 * извлекаются в Europe/Moscow (UTC+3, без DST), поэтому входы конструируем как
 * UTC-инстанты, соответствующие нужным МСК-дням:
 *   МСК X 00:00 = (X−1)T21:00:00.000Z
 * Берём полдень МСК (XT09:00:00.000Z) — безопасно от граничных эффектов TZ.
 */

// Хелпер: МСК-полдень указанного календарного дня как UTC-инстант.
function mskNoon(y: number, m: number, d: number): Date {
  // 12:00 МСК = 09:00 UTC того же календарного дня.
  return new Date(Date.UTC(y, m - 1, d, 9, 0, 0, 0))
}

describe('formatDateRangeRu', () => {
  it('один месяц и год → «6–12 июня»', () => {
    expect(formatDateRangeRu(mskNoon(2026, 6, 6), mskNoon(2026, 6, 12))).toBe('6–12 июня')
  })

  it('разные месяцы, год тот же → «28 мая – 3 июня»', () => {
    expect(formatDateRangeRu(mskNoon(2026, 5, 28), mskNoon(2026, 6, 3))).toBe('28 мая – 3 июня')
  })

  it('разные годы → «28 дек 2025 – 3 янв 2026»', () => {
    expect(formatDateRangeRu(mskNoon(2025, 12, 28), mskNoon(2026, 1, 3))).toBe('28 дек 2025 – 3 янв 2026')
  })

  it('граница месяца: 30 апр – 1 мая', () => {
    expect(formatDateRangeRu(mskNoon(2026, 4, 30), mskNoon(2026, 5, 1))).toBe('30 апреля – 1 мая')
  })

  it('извлекает МСК-день из UTC-инстанта (00:00 МСК = 21:00Z пред. дня)', () => {
    // 6 июня 00:00 МСК = 2026-06-05T21:00:00.000Z. Должен рендериться как «6 июня».
    const from = new Date('2026-06-05T21:00:00.000Z')
    // 12 июня 23:59:59.999 МСК = 2026-06-12T20:59:59.999Z.
    const to = new Date('2026-06-12T20:59:59.999Z')
    expect(formatDateRangeRu(from, to)).toBe('6–12 июня')
  })
})
