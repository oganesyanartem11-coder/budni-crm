import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DailyReportData } from './brain'

const { mockCallLlm, mockGetState, mockGetPrompt } = vi.hoisted(() => ({
  mockCallLlm: vi.fn(),
  mockGetState: vi.fn(),
  mockGetPrompt: vi.fn(),
}))

vi.mock('./llm', () => ({ callBorisDirectLlm: mockCallLlm }))
vi.mock('./state', () => ({ getDirectRoleState: mockGetState }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: mockGetPrompt }))

import {
  buildDailyDataBlock,
  buildWeeklyDataBlock,
  buildMonthlyDataBlock,
  generateDailyReportText,
  generateWeeklyReportText,
  generateMonthlyReportText,
  formatAnomalyMessage,
  type DailyReportInput,
} from './report-texts'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetState.mockResolvedValue({ mode: 'OBSERVE', frozen: false, autoNegativesEnabled: false })
  mockGetPrompt.mockReturnValue('SYSTEM_PROMPT')
  mockCallLlm.mockResolvedValue({ text: 'ТЕКСТ ОТ LLM', model: 'opus', costUsd: 0.1, downgraded: false })
})

const day = (over: Partial<DailyReportData> = {}): DailyReportData => ({
  dateLabel: '2026-07-01',
  spendRub: 2500.4,
  clicks: 42,
  impressions: 1000,
  ctr: 4.2,
  leadsTotal: 5,
  leadsFromDirect: 3,
  costPerLeadRub: 833.5,
  topQueries: [{ query: 'обеды в офис', clicks: 10, costRub: 500.7, conversions: 2 }],
  quarantine: false,
  ...over,
})

const dailyInput = (over: Partial<DailyReportInput> = {}): DailyReportInput => ({
  data: day(),
  appliedSummaries: ['минус-фразы (2): а, б'],
  wouldDoSummaries: [],
  proposalsCreated: ['Минус-фразы: 3 шт'],
  anomalies: [],
  observe: true,
  ...over,
})

describe('formatAnomalyMessage — детерминированно, без LLM', () => {
  it('critical → 🚨', () => {
    expect(formatAnomalyMessage({ severity: 'critical', kind: 'x', text: 'расход улетел' })).toBe(
      '🚨 расход улетел'
    )
  })

  it('warn → ⚠️', () => {
    expect(formatAnomalyMessage({ severity: 'warn', kind: 'x', text: 'ноль заявок' })).toBe(
      '⚠️ ноль заявок'
    )
  })
})

describe('buildDailyDataBlock — числа форматирует код', () => {
  it('рубли без копеек, CTR с 2 знаками, счётчики заявок', () => {
    const block = buildDailyDataBlock(dailyInput())
    expect(block).toContain('за 2026-07-01')
    expect(block).toContain('Расход: 2500 ₽')
    expect(block).toContain('CTR: 4.20%')
    expect(block).toContain('Заявок всего: 5, из Директа: 3')
    expect(block).toContain('Цена заявки: 834 ₽')
    expect(block).toContain('«обеды в офис»: 10 кликов, 501 ₽, конверсий 2')
  })

  it('null → «нет данных», пустой топ → «нет данных»', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({ spendRub: null, clicks: null, impressions: null, ctr: null, costPerLeadRub: null, topQueries: [] }),
      })
    )
    expect(block).toContain('Расход: нет данных')
    expect(block).toContain('CTR: нет данных')
    expect(block).toContain('Цена заявки: нет данных')
  })

  it('сделал / сделал бы / предложения / карантин / режим', () => {
    const block = buildDailyDataBlock(
      dailyInput({
        data: day({ quarantine: true }),
        appliedSummaries: [],
        wouldDoSummaries: ['ставки: 3 фразы'],
        observe: true,
      })
    )
    expect(block).toContain('Карантин: да')
    expect(block).toContain('наблюдение')
    expect(block).toContain('ЧТО СДЕЛАЛ:\nничего')
    expect(block).toContain('- ставки: 3 фразы')
    expect(block).toContain('- Минус-фразы: 3 шт')
  })

  it('одинаковый вход → одинаковый выход (детерминизм)', () => {
    expect(buildDailyDataBlock(dailyInput())).toBe(buildDailyDataBlock(dailyInput()))
  })
})

describe('generateDailyReportText', () => {
  it('heavy, critical=false, mode из state, цифры в userText, ответ LLM как есть', async () => {
    const text = await generateDailyReportText(dailyInput())
    expect(text).toBe('ТЕКСТ ОТ LLM')
    expect(mockGetPrompt).toHaveBeenCalledWith({ mode: 'OBSERVE', frozen: false })
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('daily_report')
    expect(call.tier).toBe('heavy')
    expect(call.critical).toBe(false)
    expect(call.system).toBe('SYSTEM_PROMPT')
    expect(call.userText).toContain('НЕ менять')
    expect(call.userText).toContain('Расход: 2500 ₽')
  })

  it('LLM упал → фолбэк с шапкой и сырым блоком (отчёт обязан уйти)', async () => {
    mockCallLlm.mockRejectedValue(new Error('overloaded'))
    const text = await generateDailyReportText(dailyInput())
    expect(text).toContain('📊 Дневной отчёт (без обработки — LLM недоступен)')
    expect(text).toContain('Расход: 2500 ₽')
  })

  it('LLM вернул пустой текст → тоже фолбэк', async () => {
    mockCallLlm.mockResolvedValue({ text: '  ', model: 'opus', costUsd: 0, downgraded: false })
    const text = await generateDailyReportText(dailyInput())
    expect(text).toContain('LLM недоступен')
  })
})

describe('buildWeeklyDataBlock — агрегация кодом', () => {
  const days = [
    day({ dateLabel: '2026-06-29', spendRub: 1000, clicks: 20, impressions: 500, leadsTotal: 2, leadsFromDirect: 1, topQueries: [{ query: 'пустой запрос', clicks: 5, costRub: 300, conversions: 0 }] }),
    day({ dateLabel: '2026-06-30', spendRub: 2000, clicks: 30, impressions: 500, leadsTotal: 3, leadsFromDirect: 2, topQueries: [{ query: 'обеды в офис', clicks: 10, costRub: 400, conversions: 3 }] }),
  ]

  it('суммы, средняя цена заявки, динамика по дням, лучшие/худшие запросы', () => {
    const block = buildWeeklyDataBlock(days, { llmSpendUsd: 1.234, llmCalls: 12, proposalsPending: 2 })
    expect(block).toContain('Расход: 3000 ₽')
    expect(block).toContain('Заявок всего: 5, из Директа: 3')
    expect(block).toContain('Средняя цена заявки: 1000 ₽') // 3000 / 3 — код, не LLM
    expect(block).toContain('CTR: 5.00%') // 50 кликов / 1000 показов
    expect(block).toContain('- 2026-06-29: расход 1000 ₽')
    expect(block).toContain('- 2026-06-30: расход 2000 ₽')
    expect(block).toContain('«обеды в офис»: конверсий 3')
    expect(block).toContain('«пустой запрос»: 0 конверсий')
    expect(block).toContain('Предложений без ответа владельца: 2')
    expect(block).toContain('~1.23 $ / 12 обращений')
  })

  it('нет данных → блок не падает, заявок 0 → цена заявки «нет данных»', () => {
    const block = buildWeeklyDataBlock([], { llmSpendUsd: 0, llmCalls: 0, proposalsPending: 0 })
    expect(block).toContain('данных за неделю нет')
    expect(block).toContain('Средняя цена заявки: нет данных')
  })
})

describe('generateWeeklyReportText', () => {
  it('heavy critical=false, purpose weekly_report', async () => {
    await generateWeeklyReportText([day()], { llmSpendUsd: 1, llmCalls: 5, proposalsPending: 0 })
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('weekly_report')
    expect(call.tier).toBe('heavy')
    expect(call.critical).toBe(false)
  })

  it('фолбэк при ошибке LLM', async () => {
    mockCallLlm.mockRejectedValue(new Error('down'))
    const text = await generateWeeklyReportText([day()], { llmSpendUsd: 1, llmCalls: 5, proposalsPending: 1 })
    expect(text).toContain('📊 Недельный отчёт (без обработки — LLM недоступен)')
    expect(text).toContain('ИТОГИ НЕДЕЛИ')
  })
})

describe('buildMonthlyDataBlock — динамика цены заявки по неделям', () => {
  it('группировка по неделям с понедельника', () => {
    const days = [
      // 2026-06-01 — понедельник; 2026-06-08 — следующий.
      day({ dateLabel: '2026-06-02', spendRub: 1000, leadsFromDirect: 2 }),
      day({ dateLabel: '2026-06-03', spendRub: 1000, leadsFromDirect: 2 }),
      day({ dateLabel: '2026-06-09', spendRub: 3000, leadsFromDirect: 2 }),
    ]
    const block = buildMonthlyDataBlock(days, { llmSpendUsd: 0, llmCalls: 0, monthLabel: 'июнь 2026' })
    expect(block).toContain('июнь 2026')
    expect(block).toContain('- неделя с 2026-06-01: расход 2000 ₽, заявок из Директа 4, цена заявки 500 ₽')
    expect(block).toContain('- неделя с 2026-06-08: расход 3000 ₽, заявок из Директа 2, цена заявки 1500 ₽')
  })
})

describe('generateMonthlyReportText', () => {
  const extras = { llmSpendUsd: 4.5678, llmCalls: 90, monthLabel: 'июнь 2026' }
  const llmLine = '💰 На аналитику потрачено ~4.57 $ / 90 обращений к LLM — это отдельные деньги, не рекламный бюджет.'

  it('heavy critical=true, строка про LLM-деньги добавлена КОДОМ в конце', async () => {
    const text = await generateMonthlyReportText([day()], extras)
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.purpose).toBe('monthly_report')
    expect(call.critical).toBe(true)
    expect(text).toBe(`ТЕКСТ ОТ LLM\n\n${llmLine}`)
  })

  it('фолбэк при ошибке LLM — строка про LLM-деньги всё равно в конце', async () => {
    mockCallLlm.mockRejectedValue(new Error('down'))
    const text = await generateMonthlyReportText([day()], extras)
    expect(text).toContain('📊 Месячный отчёт (без обработки — LLM недоступен)')
    expect(text.endsWith(llmLine)).toBe(true)
  })
})
