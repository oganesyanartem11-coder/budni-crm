import { describe, it, expect } from 'vitest'
import { parseAnalystOutput, filterAnalystDrafts, buildAnalystUserText, ANALYST_MAX_QUESTIONS_HINT } from './analyst'

describe('parseAnalystOutput', () => {
  const item = {
    topicKey: 'funnel_zero_series',
    question: 'Клик→заявка обвалился 09.07: 0 заявок при живых визитах?',
    check: 'серия цели Метрики по дням за 14 дней',
    checkKey: 'metrika_goal_series',
    checkParams: { windowDays: 14 },
  }

  it('чистый JSON-массив → драфты с checkSpec', () => {
    const out = parseAnalystOutput(JSON.stringify([item]))
    expect(out).toHaveLength(1)
    expect(out[0].topicKey).toBe('funnel_zero_series')
    expect(out[0].checkSpec).toEqual({ key: 'metrika_goal_series', params: { windowDays: 14 } })
  })

  it('обёртка в ```json ...``` разбирается', () => {
    const raw = '```json\n' + JSON.stringify([item]) + '\n```'
    expect(parseAnalystOutput(raw)).toHaveLength(1)
  })

  it('объект-обёртка {questions:[...]} разбирается', () => {
    expect(parseAnalystOutput(JSON.stringify({ questions: [item] }))).toHaveLength(1)
  })

  it('мусор → пустой массив (fail-safe)', () => {
    expect(parseAnalystOutput('Борис не смог, вот текст')).toEqual([])
    expect(parseAnalystOutput('')).toEqual([])
  })

  it('элемент без вопроса/ключа проверки пропускается', () => {
    const bad = [{ topicKey: 't', check: 'c', checkKey: 'metrika_goal_series' }, item]
    expect(parseAnalystOutput(JSON.stringify(bad))).toHaveLength(1)
  })
})

describe('filterAnalystDrafts', () => {
  const dash = 'ДНИ:\n- 2026-07-09: 800 ₽ / 10 / 0 / —\nисторической CR 7.96%'
  const good = {
    topicKey: 'funnel_zero_series',
    question: '0 заявок при 10 кликах 09.07 — воронка?',
    check: 'серия цели Метрики',
    checkSpec: { key: 'metrika_goal_series', params: { windowDays: 14 } },
  }

  it('оставляет валидный заземлённый драфт с проверкой из белого списка', () => {
    const r = filterAnalystDrafts([good], dash, 3)
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toHaveLength(0)
  })

  it('дропает проверку вне белого списка', () => {
    const bad = { ...good, checkSpec: { key: 'suspend_campaign', params: {} } }
    const r = filterAnalystDrafts([bad], dash, 3)
    expect(r.kept).toHaveLength(0)
    expect(r.dropped[0].reason).toMatch(/whitelist|список/i)
  })

  it('дропает драфт с выдуманным числом (не заземлён)', () => {
    const bad = { ...good, question: 'CPL взлетел до 340 ₽ — режь' }
    const r = filterAnalystDrafts([bad], dash, 3)
    expect(r.kept).toHaveLength(0)
    expect(r.dropped[0].reason).toMatch(/заземл|ground/i)
    expect(r.dropped[0].detail).toMatch(/340/)
  })

  it('число из собственных checkParams заземлено (окно проверки, не факт данных)', () => {
    // «14» нет в дашборде, но есть в checkParams.windowDays — это параметр проверки.
    const d = { ...good, question: 'Сравнить конверсии за 14 дней — серия нулей?', checkSpec: { key: 'metrika_goal_series', params: { windowDays: 14 } } }
    const r = filterAnalystDrafts([d], dash, 3)
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toHaveLength(0)
  })

  it('обрезает до максимума вопросов', () => {
    const many = [good, { ...good, topicKey: 't2', question: '0 заявок 2' }, { ...good, topicKey: 't3', question: '0 заявок 3' }, { ...good, topicKey: 't4', question: '0 заявок 4' }]
    const r = filterAnalystDrafts(many, dash, ANALYST_MAX_QUESTIONS_HINT)
    expect(r.kept.length).toBeLessThanOrEqual(ANALYST_MAX_QUESTIONS_HINT)
  })
})

describe('buildAnalystUserText', () => {
  it('содержит инструкцию-заземление и сам дашборд', () => {
    const t = buildAnalystUserText('ДАШБОРД ...числа...')
    expect(t).toMatch(/ДАШБОРД/)
    expect(t).toMatch(/JSON/)
    // запрет выдумывать числа и обещать действия — в инструкции
    expect(t).toMatch(/не выдумыв|только из данных/i)
  })
})
