import { describe, it, expect } from 'vitest'
import { parseCallCommand, buildCallHint, type PhraseHourVisit } from './calls'

// Фиксированный «сейчас»: 2026-07-16 12:00 МСК (09:00 UTC).
const NOW = new Date('2026-07-16T09:00:00Z')

describe('parseCallCommand — разбор «звонок <телефон> [время] [коммент]»', () => {
  it('ДД.ММ ЧЧ:ММ + комментарий → МСК-время как UTC, метка, коммент', () => {
    const r = parseCallCommand('звонок 79991234567 16.07 11:28 стройка москва', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.phoneDigits).toBe('79991234567')
    // 11:28 МСК = 08:28 UTC того же дня.
    expect(r.atUtc.toISOString()).toBe('2026-07-16T08:28:00.000Z')
    expect(r.atMskLabel).toBe('16.07 11:28')
    expect(r.comment).toBe('стройка москва')
  })

  it('«сегодня ЧЧ:ММ» → сегодняшний МСК-день', () => {
    const r = parseCallCommand('звонок 1234 сегодня 14:49', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.atUtc.toISOString()).toBe('2026-07-16T11:49:00.000Z') // 14:49 МСК
    expect(r.atMskLabel).toBe('16.07 14:49')
  })

  it('«вчера ЧЧ:ММ» → вчерашний МСК-день (переход через полночь корректен)', () => {
    const r = parseCallCommand('звонок 1234 вчера 23:30', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.atUtc.toISOString()).toBe('2026-07-15T20:30:00.000Z') // 15.07 23:30 МСК
    expect(r.atMskLabel).toBe('15.07 23:30')
  })

  it('голое ЧЧ:ММ (без даты) → сегодня', () => {
    const r = parseCallCommand('звонок 1234 11:28 перезвонил', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.atMskLabel).toBe('16.07 11:28')
    expect(r.comment).toBe('перезвонил')
  })

  it('без времени → now, коммент опционален', () => {
    const r = parseCallCommand('звонок 79990001122', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.atUtc.getTime()).toBe(NOW.getTime())
    expect(r.atMskLabel).toBe('16.07 12:00')
    expect(r.comment).toBe('')
  })

  it('телефон < 4 цифр → invalid', () => {
    expect(parseCallCommand('звонок 99', NOW).kind).toBe('invalid')
  })
  it('пустая команда → invalid', () => {
    expect(parseCallCommand('звонок', NOW).kind).toBe('invalid')
  })
  it('битое время → invalid', () => {
    expect(parseCallCommand('звонок 1234 16.07 25:61', NOW).kind).toBe('invalid')
  })
})

describe('buildCallHint — подсказка по времени (гипотеза, не атрибуция)', () => {
  const rows: PhraseHourVisit[] = [
    { phrase: 'организация обедов на стройке москва', hour: 10, visits: 1 },
    { phrase: 'доставка обедов в офис вао', hour: 11, visits: 1 },
    { phrase: 'обеды в офис с доставкой москва', hour: 0, visits: 1 }, // вне окна
  ]

  it('окно ±1ч: перечисляет фразы часа звонка, гипотеза-дисклеймер, контекст дня', () => {
    const { text, meta } = buildCallHint(rows, { callHourMsk: 11, dayVisits: 9 })
    expect(text).toMatch(/2 рекл/) // 10 и 11 час
    expect(text).toMatch(/на стройке москва/)
    expect(text).toMatch(/в офис вао/)
    expect(text).not.toMatch(/обеды в офис с доставкой москва/) // час 0 — вне окна
    expect(text).toMatch(/гипотеза по времени, не атрибуция/i)
    expect(text).toMatch(/9/) // контекст дня
    expect(meta.windowVisits).toBe(2)
    expect(meta.dayVisits).toBe(9)
    expect(meta.windowPhrases).toContain('доставка обедов в офис вао')
    expect(meta.note).toMatch(/гипотеза/i)
  })

  it('0 визитов в окне → честно «нет», дисклеймер сохраняется', () => {
    const { text, meta } = buildCallHint(rows, { callHourMsk: 5, dayVisits: 9 })
    expect(text).toMatch(/нет|0 реклам/i)
    expect(text).toMatch(/гипотеза по времени, не атрибуция/i)
    expect(meta.windowVisits).toBe(0)
  })
})
