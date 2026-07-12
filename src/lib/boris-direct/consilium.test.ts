import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Недельный консилиум (heavy): по срезу недели даёт владельцу 3–5 гипотез ТЕКСТОМ.
 * СТРОГО текст — не в кабинет, не предложения-с-кнопками, не действия. Fail-safe:
 * LLM упал/таймаут → '' (недельный отчёт уходит без секции консилиума).
 */

const { mockLlm, mockState } = vi.hoisted(() => ({ mockLlm: vi.fn(), mockState: vi.fn() }))
vi.mock('./llm', () => ({ callBorisDirectLlm: mockLlm }))
vi.mock('./prompts', () => ({ getBorisDirectSystemPrompt: () => 'SYS' }))
vi.mock('./state', () => ({ getDirectRoleState: mockState }))

import { buildConsiliumDataBlock, generateWeeklyConsilium, type WeeklyConsiliumInput } from './consilium'

const INPUT: WeeklyConsiliumInput = {
  period: { from: '2026-07-06', to: '2026-07-12' },
  days: [
    { dateLabel: '2026-07-06', spendRub: 1200, clicks: 20, leadsFromDirect: 2, costPerLeadRub: 600 },
    { dateLabel: '2026-07-07', spendRub: 900, clicks: 15, leadsFromDirect: 1, costPerLeadRub: 900 },
  ],
  topQueries: [
    { query: 'бизнес ланч доставка', clicks: 18, costRub: 900, conversions: 2 },
    { query: 'обеды вакансии', clicks: 12, costRub: 400, conversions: 0 },
  ],
  leadCounts: { directAttrib: 3, metrika: 4, delivered: 2 },
  underspendWeekly: { medianSpendRub: 1050, dailyBudgetRub: 3000 },
  matchTypeShare: { synonymPct: 37 },
  lessonsDigest: 'Группа G1: заявки дешевле среднего.',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockState.mockResolvedValue({ mode: 'LIVE', frozen: false })
})

describe('buildConsiliumDataBlock', () => {
  it('содержит период, дни, 3 счётчика заявок, фразы, недорасход, SYNONYM', () => {
    const b = buildConsiliumDataBlock(INPUT)
    expect(b).toContain('2026-07-06')
    expect(b).toContain('бизнес ланч доставка')
    expect(b).toMatch(/Директ-атрибуция 3/)
    expect(b).toMatch(/Метрика 4/)
    expect(b).toMatch(/Доставлено 2/)
    expect(b).toContain('1050') // медиана недорасхода
    expect(b).toContain('37%') // доля SYNONYM
    expect(b).toContain('заявки дешевле среднего') // уроки
  })
})

describe('generateWeeklyConsilium', () => {
  it('heavy-вызов → текст гипотез владельцу; промпт запрещает кабинет/кнопки', async () => {
    mockLlm.mockResolvedValue({ text: 'Консилиум недели:\n1. ...', model: 'opus', costUsd: 0.05, downgraded: false })
    const out = await generateWeeklyConsilium(INPUT)
    expect(out).toContain('Консилиум недели')
    const call = mockLlm.mock.calls[0][0]
    expect(call.purpose).toBe('weekly_consilium')
    expect(call.tier).toBe('heavy')
    // Инструкция: гипотезы, НЕ команды/кабинет.
    expect(call.userText).toMatch(/гипотез/i)
    expect(call.userText).toMatch(/не пиши|в кабинет|кнопок/i)
    // Данные переданы (цифры не выдумываются LLM).
    expect(call.userText).toContain('бизнес ланч доставка')
  })

  it('LLM упал (таймаут) → пустая строка (fail-safe, секции нет, weekly не блокируется)', async () => {
    mockLlm.mockRejectedValue(new Error('timeout'))
    const out = await generateWeeklyConsilium(INPUT)
    expect(out).toBe('')
  })

  it('LLM вернул пустой текст → пустая строка (нет секции)', async () => {
    mockLlm.mockResolvedValue({ text: '   ', model: 'opus', costUsd: 0.01, downgraded: false })
    const out = await generateWeeklyConsilium(INPUT)
    expect(out).toBe('')
  })
})
