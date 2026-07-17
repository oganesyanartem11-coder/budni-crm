import { describe, it, expect } from 'vitest'
import { buildAnalystDashboard, estimateTokens, type AnalystDashboardInput } from './analyst-dashboard'
import type { AnalystQuestion } from './questions'

/** Минимальный валидный вход (только обязательное). */
function baseInput(over: Partial<AnalystDashboardInput> = {}): AnalystDashboardInput {
  return {
    today: '2026-07-14',
    mode: 'ADVISE',
    frozen: false,
    window: {
      days: [
        { date: '2026-07-08', spendRub: 900, clicks: 12, leads: 2, cplRub: 450 },
        { date: '2026-07-09', spendRub: 800, clicks: 10, leads: 0, cplRub: null },
        { date: '2026-07-10', spendRub: 750, clicks: 9, leads: 0, cplRub: null },
      ],
    },
    ...over,
  }
}

// Спринт 17.07 (дыра данных): звонки — лиды БЕЗ рекламной разметки (phone_call), в
// окно fromDirect не попадают. Аналитик рассуждал «дорогие клики без конверсий», не
// видя, что лиды идут ЗВОНКАМИ → мог предложить резать конвертящие фразы.
describe('buildAnalystDashboard: строка ЗВОНКОВ (ручной приём, вне атрибуции)', () => {
  it('0 форменных заявок И N звонков → в дашборде ОБЕ цифры', () => {
    const text = buildAnalystDashboard(
      baseInput({
        window: {
          days: [
            { date: '2026-07-15', spendRub: 4600, clicks: 43, leads: 0, cplRub: null },
            { date: '2026-07-16', spendRub: 3200, clicks: 30, leads: 0, cplRub: null },
          ],
        },
        calls: { windowCount: 3 },
      })
    )
    // Форменные заявки = 0 (в днях) видны:
    expect(text).toMatch(/2026-07-15: 4600 ₽ \/ 43 \/ 0 \//)
    // И звонки = 3 видны отдельной строкой, помеченной «вне атрибуции»:
    expect(text).toMatch(/ЗВОНКИ.*вне атрибуции.*3/i)
  })

  it('звонков нет (0) → строки ЗВОНКОВ нет (секция только при наличии данных)', () => {
    const text = buildAnalystDashboard(baseInput({ calls: { windowCount: 0 } }))
    expect(text).not.toMatch(/ЗВОНКИ/i)
  })

  it('calls не передан → строки ЗВОНКОВ нет (обратная совместимость)', () => {
    expect(buildAnalystDashboard(baseInput())).not.toMatch(/ЗВОНКИ/i)
  })
})

describe('buildAnalystDashboard', () => {
  it('шапка: день, режим, заморозка', () => {
    const text = buildAnalystDashboard(baseInput())
    expect(text).toMatch(/2026-07-14/)
    expect(text).toMatch(/ADVISE/)
  })

  it('окно дней: расход/клики/заявки/CPL, «—» при нулевых заявках', () => {
    const text = buildAnalystDashboard(baseInput())
    expect(text).toMatch(/2026-07-09/)
    expect(text).toMatch(/800/) // расход
    expect(text).toMatch(/10/) // клики
    // День с 0 заявок печатает CPL как «—» (не выдумывает число).
    const line09 = text.split('\n').find((l) => l.includes('2026-07-09'))!
    expect(line09).toMatch(/—/)
  })

  it('серия нулевых заявок ВИДНА как ряд (ретро-гейт опирается на это)', () => {
    const text = buildAnalystDashboard(baseInput())
    const zeroDays = text.split('\n').filter((l) => /2026-07-(09|10)/.test(l))
    expect(zeroDays).toHaveLength(2)
    // Оба дня показывают заявки=0 явно.
    for (const l of zeroDays) expect(l).toMatch(/\b0\b/)
  })

  it('прогноз: строка включается, когда есть; секции нет, когда null', () => {
    const withF = buildAnalystDashboard(baseInput({ forecast: { line: 'клики: ждал 11±3, факт 10; расход: ждал 820±90 ₽, факт 800 ₽' } }))
    expect(withF).toMatch(/ПРОГНОЗ/i)
    expect(withF).toMatch(/ждал 11/)
    const noF = buildAnalystDashboard(baseInput({ forecast: { line: null } }))
    expect(noF).not.toMatch(/ждал/)
  })

  it('лесенка: медиана входа, доля ниже входа, дрейф', () => {
    const text = buildAnalystDashboard(
      baseInput({ ladder: { entryMedianRub: 95, belowEntryPct: 20, phrases: 40, driftMedianPct: 0.05, driftBelowEntryPp: 2 } })
    )
    expect(text).toMatch(/ЛЕСЕНКА/i)
    expect(text).toMatch(/95/)
    expect(text).toMatch(/20/)
  })

  it('активные вопросы прошлых дней: статус + результат проверки', () => {
    const q: AnalystQuestion = {
      id: 'q_2026-07-13_0',
      question: 'Клик→заявка обвалился?',
      status: 'checking',
      check: 'серия цели Метрики',
      result: null,
      createdMsk: '2026-07-13',
      updatedMsk: '2026-07-13',
      topicKey: 'funnel_zero_series',
    }
    const text = buildAnalystDashboard(baseInput({ activeQuestions: [q] }))
    expect(text).toMatch(/ВОПРОСЫ/i)
    expect(text).toMatch(/checking/)
    expect(text).toMatch(/Клик→заявка/)
  })

  it('выходы детекторов дня и открытый консилиум включены', () => {
    const text = buildAnalystDashboard(
      baseInput({
        detectorAlerts: ['[ВОРОНКА] визиты живые (57), целей ноль'],
        consilium: ['Гипотеза: ставки протухли относительно аукциона'],
      })
    )
    expect(text).toMatch(/ДЕТЕКТОРЫ/i)
    expect(text).toMatch(/визиты живые/)
    expect(text).toMatch(/КОНСИЛИУМ/i)
    expect(text).toMatch(/ставки протухли/)
  })

  it('деньги/выручка включены, когда есть', () => {
    const text = buildAnalystDashboard(baseInput({ money: { lines: ['Выручка недели: 40000 ₽ по 2 сделкам'] } }))
    expect(text).toMatch(/ДЕНЬГИ|ВЫРУЧКА/i)
    expect(text).toMatch(/40000/)
  })

  it('неизвестный расход печатается как «?» (не выдумываем)', () => {
    const text = buildAnalystDashboard(
      baseInput({ window: { days: [{ date: '2026-07-09', spendRub: null, clicks: 25, leads: 0, cplRub: null }] } })
    )
    const line = text.split('\n').find((l) => l.includes('2026-07-09'))!
    expect(line).toMatch(/\?/)
    expect(line).not.toMatch(/null/)
  })

  it('детерминизм: один вход → один текст', () => {
    const a = buildAnalystDashboard(baseInput())
    const b = buildAnalystDashboard(baseInput())
    expect(a).toBe(b)
  })
})

describe('estimateTokens', () => {
  it('грубая оценка ~ символы/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('')).toBe(0)
  })
})
