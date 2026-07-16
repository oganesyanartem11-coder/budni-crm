import { describe, it, expect } from 'vitest'
import { parseCallCommand, buildCallHint, type PhraseHourVisit } from './calls'
import { parsePhraseHourResponse, type MetrikaStatResponse } from './metrika-client'
import phraseHour15jul from './__fixtures__/metrika-phrasehour-15jul.json'

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

  // ШАГ 7: человеческие форматы телефона (много-токенные) → чистые цифры.
  it.each([
    ['звонок +7 (966) 374-87-06', '79663748706'],
    ['звонок 8 966 374 87 06', '89663748706'],
    ['звонок +7-966-374-87-06', '79663748706'],
    ['звонок 8(966)374-87-06 16.07 11:28 стройка', '89663748706'],
  ])('телефон «%s» → %s', (cmd, digits) => {
    const r = parseCallCommand(cmd, NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.phoneDigits).toBe(digits)
  })

  it('много-токенный телефон + дата/время/коммент разделяются верно', () => {
    const r = parseCallCommand('звонок 8 966 374 87 06 16.07 11:28 перезвон по стройке', NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.phoneDigits).toBe('89663748706')
    expect(r.atMskLabel).toBe('16.07 11:28')
    expect(r.comment).toBe('перезвон по стройке')
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

  it('окно пусто, НО данные видны (валидные часы) → «не было в этот час», НЕ «недоступен»', () => {
    const { text, meta } = buildCallHint(rows, { callHourMsk: 5, dayVisits: 9 }) // окно [4,5,6] — визитов нет
    expect(meta.status).toBe('empty_window')
    expect(text).toMatch(/не было/i)
    expect(text).toMatch(/9/) // за день были в другие часы
    expect(text).toMatch(/гипотеза по времени, не атрибуция/i)
    expect(meta.windowVisits).toBe(0)
  })

  // ШАГ 6 ГЛАВНОЕ ПРАВИЛО: «не смотрел» ≠ «не было». Час не распознан (NaN) при dayVisits>0.
  it('часовой срез не прочитан (все hour=NaN) при dayVisits>0 → «недоступен», НИКОГДА не «0»', () => {
    const broken: PhraseHourVisit[] = [
      { phrase: 'a', hour: NaN, visits: 6 },
      { phrase: 'b', hour: NaN, visits: 5 },
    ]
    const { text, meta } = buildCallHint(broken, { callHourMsk: 14, dayVisits: 11 })
    expect(meta.status).toBe('unavailable')
    expect(text).toMatch(/недоступен|не смог посмотреть/i)
    expect(text).not.toMatch(/визитов нет \(0\)/) // НЕ подаём ноль как факт
    expect(text).toMatch(/11/) // называем дневные, чтобы владелец видел «данные есть, срез — нет»
  })
})

describe('РЕГРЕССИЯ бага «тихий ложный ноль» (16.07): фикстура сырого ответа Метрики', () => {
  it('parsePhraseHourResponse парсит час «ЧЧ:00» верно (не NaN)', () => {
    const rows = parsePhraseHourResponse(phraseHour15jul as unknown as MetrikaStatResponse)
    expect(rows).toHaveLength(11)
    expect(rows.every((r) => Number.isInteger(r.hour))).toBe(true) // раньше все были NaN
    expect(rows.filter((r) => r.hour === 15)).toHaveLength(3) // ч15 — три фразы
  })

  it('РЕАЛЬНЫЙ КЕЙС 15.07 14:49 → окно ч13–15 НЕПУСТО (6 визитов), а не ложный ноль', () => {
    const rows = parsePhraseHourResponse(phraseHour15jul as unknown as MetrikaStatResponse)
    const dayVisits = rows.reduce((s, r) => s + r.visits, 0)
    const { text, meta } = buildCallHint(rows, { callHourMsk: 14, dayVisits })
    expect(dayVisits).toBe(11)
    expect(meta.status).toBe('ok')
    expect(meta.windowVisits).toBe(6) // ч13(1)+ч14(2)+ч15(3)
    expect(meta.windowPhrases).toContain('заказ еды порционно офис')
    expect(meta.windowPhrases).toContain('питание для вахтовиков')
    expect(text).toMatch(/6 рекл/)
  })
})
