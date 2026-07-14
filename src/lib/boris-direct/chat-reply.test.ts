import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockCallLlm,
  mockGetDirectRoleState,
  mockGetActiveLessonsReport,
  mockSnapshotFindFirst,
  mockProposalCount,
} = vi.hoisted(() => ({
  mockCallLlm: vi.fn(),
  mockGetDirectRoleState: vi.fn(),
  mockGetActiveLessonsReport: vi.fn(),
  mockSnapshotFindFirst: vi.fn(),
  mockProposalCount: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectSnapshot: { findFirst: mockSnapshotFindFirst },
    borisDirectProposal: { count: mockProposalCount },
  },
}))
vi.mock('./llm', () => ({ callBorisDirectLlm: mockCallLlm }))
vi.mock('./state', () => ({ getDirectRoleState: mockGetDirectRoleState }))
vi.mock('./lessons', () => ({ getActiveLessonsReport: mockGetActiveLessonsReport }))
// getBorisDirectSystemPrompt — РЕАЛЬНЫЙ (личность+домен, чистая функция).

import { answerDirectFreeText, buildDirectChatContext } from './chat-reply'

const dailyPayload = {
  dateLabel: '2026-07-13',
  spendRub: 1200,
  clicks: 14,
  impressions: 500,
  ctr: 2.8,
  leadsTotal: 2,
  leadsFromDirect: 2,
  costPerLeadRub: 600,
  topQueries: [{ query: 'доставка обедов в офис', clicks: 8, costRub: 700, conversions: 1 }],
  quarantine: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetDirectRoleState.mockResolvedValue({ mode: 'LIVE', frozen: false, autoNegativesEnabled: false })
  mockSnapshotFindFirst.mockResolvedValue({ payload: dailyPayload })
  mockProposalCount.mockResolvedValue(2)
  mockGetActiveLessonsReport.mockResolvedValue('Урок: «фабрика обедов павловский посад» — спорный, жду тебя.')
  mockCallLlm.mockResolvedValue({ text: 'Синонимы по запросам не размечены, но вот пофразный расход…', model: 'sonnet', costUsd: 0, downgraded: false })
})

describe('answerDirectFreeText — доменный ответ ролью трафика (read-only)', () => {
  it('собирает системный промт: домен + живой контекст + guardrails + инвентарь; зовёт LIGHT llm', async () => {
    const out = await answerDirectFreeText('Борис, что там по кампании?')

    expect(out).toBe('Синонимы по запросам не размечены, но вот пофразный расход…')
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
    const call = mockCallLlm.mock.calls[0][0]
    expect(call.tier).toBe('light')
    expect(call.purpose).toBe('chat_reply')
    expect(call.userText).toBe('Борис, что там по кампании?')

    const sys = call.system as string
    // Домен (личность+роль трафика) — из getBorisDirectSystemPrompt.
    expect(sys).toContain('платного трафика')
    // Живой контекст.
    expect(sys).toContain('ЖИВОЙ КОНТЕКСТ')
    expect(sys).toContain('2026-07-13') // последний день
    expect(sys).toContain('Предложений без ответа владельца: 2')
    expect(sys).toContain('фабрика обедов павловский посад') // уроки
    // Окна решений (14/30).
    expect(sys).toMatch(/минусы.*14/)
    expect(sys).toMatch(/вердикт.*30/)
    // Guardrails: только совет, не обещать действия.
    expect(sys).toContain('НЕ обещай')
    // Инвентарь команд.
    expect(sys).toContain('«Борис, статус»')
    expect(sys).toContain('«Борис, почему')
  })

  it('честность про синонимы: guardrail про MatchType, которого нет в хранимых данных', async () => {
    await answerDirectFreeText('Борис, Да, готовь предложение по чистке синонимов, там 78% кликов')
    const sys = mockCallLlm.mock.calls[0][0].system as string
    expect(sys).toContain('MatchType')
    expect(sys).toContain('не хранится')
    expect(sys).toContain('пофразная экономика')
  })

  it('LLM упал → честный фолбэк с командами (не throw, read-only)', async () => {
    mockCallLlm.mockRejectedValue(new Error('anthropic 529'))
    const out = await answerDirectFreeText('Борис, посоветуй что-нибудь')
    expect(out).toContain('логи')
    expect(out).toContain('Борис, статус')
  })

  it('никаких write: не зовёт ничего пишущего (только чтения + llm)', async () => {
    await answerDirectFreeText('Борис, привет')
    // Единственные вызовы — чтения контекста и одна light-генерация.
    expect(mockSnapshotFindFirst).toHaveBeenCalled()
    expect(mockProposalCount).toHaveBeenCalledWith({ where: { status: 'PENDING' } })
    expect(mockCallLlm).toHaveBeenCalledTimes(1)
  })
})

describe('buildDirectChatContext', () => {
  it('статус + окна + последний день + предложения + уроки', async () => {
    const ctx = await buildDirectChatContext({ mode: 'OBSERVE', frozen: true, autoNegativesEnabled: false })
    expect(ctx).toContain('стоп-кран') // frozen
    expect(ctx).toMatch(/минусы.*14/)
    expect(ctx).toContain('2026-07-13')
    expect(ctx).toContain('Предложений без ответа владельца: 2')
    expect(ctx).toContain('фабрика обедов павловский посад')
  })

  it('нет свежего снапшота → честная строка, не падает', async () => {
    mockSnapshotFindFirst.mockResolvedValue(null)
    const ctx = await buildDirectChatContext({ mode: 'LIVE', frozen: false, autoNegativesEnabled: false })
    expect(ctx).toContain('Свежих дневных данных пока нет')
  })
})
