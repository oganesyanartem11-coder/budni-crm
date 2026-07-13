import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PROPOSAL_COOLDOWN_DAYS, PROPOSAL_TTL_DAYS } from './config'

const {
  mockFindFirst,
  mockCreate,
  mockUpdateMany,
  mockFindUnique,
  mockFindMany,
  mockUpdate,
  mockSendToDirectChat,
  mockSetAutoNegativesEnabled,
  mockRecordOwnerDecision,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockSendToDirectChat: vi.fn(),
  mockSetAutoNegativesEnabled: vi.fn(),
  mockRecordOwnerDecision: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectProposal: {
      findFirst: mockFindFirst,
      create: mockCreate,
      updateMany: mockUpdateMany,
      findUnique: mockFindUnique,
      findMany: mockFindMany,
      update: mockUpdate,
    },
  },
}))
vi.mock('./telegram', () => ({
  sendToDirectChat: mockSendToDirectChat,
}))
vi.mock('./state', () => ({
  setAutoNegativesEnabled: mockSetAutoNegativesEnabled,
}))
vi.mock('./learning', () => ({
  recordOwnerDecision: mockRecordOwnerDecision,
}))

import {
  createProposal,
  decideProposal,
  expireStaleProposals,
  getAcceptedUnapplied,
  markProposalApplied,
  formatProposalSummary,
  type ProposalInput,
} from './proposals'
import { buildDisputedMinusProposalDraft } from './minus-proposal'

const DAY_MS = 24 * 60 * 60 * 1000

const baseInput: ProposalInput = {
  type: 'budget',
  topicKey: 'budget_daily',
  payload: { dailyBudgetRub: 3500 },
  argument: 'CPA держится ниже цели неделю.',
  question: 'Поднимаем дневной бюджет?',
  triggerMetric: 'cpa',
  triggerValue: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSendToDirectChat.mockResolvedValue({ ok: true })
  mockCreate.mockResolvedValue({ id: 'prop_new' })
  mockSetAutoNegativesEnabled.mockResolvedValue(undefined)
  mockRecordOwnerDecision.mockResolvedValue(undefined)
})

describe('createProposal — дедуп и cooldown', () => {
  it('висит PENDING с тем же topicKey → pending_exists, не создаём и не шлём', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'prop_pending' })
    const result = await createProposal(baseInput)
    expect(result).toEqual({ created: false, reason: 'pending_exists' })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSendToDirectChat).not.toHaveBeenCalled()
  })

  it('cooldown активен, сдвиг < 30% → cooldown', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null) // pending нет
      .mockResolvedValueOnce({
        id: 'prop_rej',
        cooldownUntil: new Date(Date.now() + 5 * DAY_MS),
        triggerValue: 100,
      })
    const result = await createProposal({ ...baseInput, triggerValue: 110 })
    expect(result).toEqual({ created: false, reason: 'cooldown' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('cooldown активен, но triggerValue не задан → cooldown', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'prop_rej',
        cooldownUntil: new Date(Date.now() + 5 * DAY_MS),
        triggerValue: 100,
      })
    const result = await createProposal({ ...baseInput, triggerValue: undefined })
    expect(result).toEqual({ created: false, reason: 'cooldown' })
  })

  it('cooldown активен, но сдвиг ≥ 30% → создаём и шлём с кнопками bdir', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'prop_rej',
        cooldownUntil: new Date(Date.now() + 5 * DAY_MS),
        triggerValue: 100,
      })
    const result = await createProposal({ ...baseInput, triggerValue: 140 })
    expect(result).toEqual({ created: true })
    expect(mockCreate).toHaveBeenCalledOnce()
    const [text, opts] = mockSendToDirectChat.mock.calls[0]
    expect(text).toContain('<b>ПРЕДЛОЖЕНИЕ</b>')
    expect(text).toContain('<b>АРГУМЕНТ</b>')
    expect(text).toContain('<b>ВОПРОС</b>')
    const kb = JSON.stringify(opts.replyMarkup)
    expect(kb).toContain('bdir:accept:prop_new')
    expect(kb).toContain('bdir:reject:prop_new')
  })

  it('cooldown истёк → создаём без оглядки на сдвиг', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'prop_rej',
        cooldownUntil: new Date(Date.now() - DAY_MS),
        triggerValue: 100,
      })
    const result = await createProposal({ ...baseInput, triggerValue: 101 })
    expect(result).toEqual({ created: true })
  })

  it('отправка упала → предложение всё равно created (остаётся PENDING)', async () => {
    mockFindFirst.mockResolvedValue(null)
    mockSendToDirectChat.mockResolvedValue({ ok: false, error: 'forbidden' })
    const result = await createProposal(baseInput)
    expect(result).toEqual({ created: true })
    expect(mockCreate).toHaveBeenCalledOnce()
  })
})

describe('decideProposal — атомарный claim', () => {
  it('reject → REJECTED + cooldownUntil ≈ now + 14 дней', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      type: 'budget',
      payload: { dailyBudgetRub: 3500 },
    })
    const before = Date.now()
    const result = await decideProposal('p1', 'reject')
    expect(result.ok).toBe(true)
    expect(result.summaryText).toContain('Отклонено')
    const args = mockUpdateMany.mock.calls[0][0]
    expect(args.where).toEqual({ id: 'p1', status: 'PENDING' })
    expect(args.data.status).toBe('REJECTED')
    const cooldown = (args.data.cooldownUntil as Date).getTime()
    const expected = before + PROPOSAL_COOLDOWN_DAYS * DAY_MS
    expect(Math.abs(cooldown - expected)).toBeLessThan(5000)
  })

  it('accept → ACCEPTED + decidedAt, в тексте «применю на ближайшем тике»', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p2',
      type: 'budget',
      payload: { dailyBudgetRub: 3500 },
    })
    const result = await decideProposal('p2', 'accept')
    expect(result.ok).toBe(true)
    expect(result.summaryText).toContain('Применю на ближайшем тике')
    const args = mockUpdateMany.mock.calls[0][0]
    expect(args.data.status).toBe('ACCEPTED')
    expect(args.data.decidedAt).toBeInstanceOf(Date)
    expect(args.data.cooldownUntil).toBeUndefined()
  })

  it('двойной клик: count===0 → {ok:false}, спец-обработка не зовётся', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    const result = await decideProposal('p3', 'accept')
    expect(result.ok).toBe(false)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockRecordOwnerDecision).not.toHaveBeenCalled()
    expect(mockSetAutoNegativesEnabled).not.toHaveBeenCalled()
  })

  it('minus_words accept → recordOwnerDecision(id, true)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p4',
      type: 'minus_words',
      payload: { phrases: ['бесплатно'] },
    })
    await decideProposal('p4', 'accept')
    expect(mockRecordOwnerDecision).toHaveBeenCalledWith('p4', true)
  })

  it('minus_words reject → recordOwnerDecision(id, false)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p5',
      type: 'minus_words',
      payload: { phrases: ['бесплатно'] },
    })
    await decideProposal('p5', 'reject')
    expect(mockRecordOwnerDecision).toHaveBeenCalledWith('p5', false)
  })

  it('lift_minus_gate accept → setAutoNegativesEnabled(true) + помечен applied', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p6',
      type: 'lift_minus_gate',
      payload: { streak: 10 },
    })
    mockUpdate.mockResolvedValue({})
    const result = await decideProposal('p6', 'accept')
    expect(mockSetAutoNegativesEnabled).toHaveBeenCalledWith(true)
    expect(result.summaryText).toContain('Гейт снят')
    // markProposalApplied → update payload.applied=true
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p6' },
        data: { payload: expect.objectContaining({ applied: true }) },
      })
    )
  })

  it('lift_minus_gate reject → гейт НЕ трогаем', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindUnique.mockResolvedValue({
      id: 'p7',
      type: 'lift_minus_gate',
      payload: {},
    })
    await decideProposal('p7', 'reject')
    expect(mockSetAutoNegativesEnabled).not.toHaveBeenCalled()
  })
})

describe('expireStaleProposals', () => {
  it('PENDING старше TTL → EXPIRED, возвращает count', async () => {
    mockUpdateMany.mockResolvedValue({ count: 3 })
    const now = new Date('2026-07-02T12:00:00Z')
    const count = await expireStaleProposals(now)
    expect(count).toBe(3)
    const args = mockUpdateMany.mock.calls[0][0]
    expect(args.data.status).toBe('EXPIRED')
    expect(args.where.status).toBe('PENDING')
    const cutoff = args.where.createdAt.lt as Date
    expect(cutoff.getTime()).toBe(now.getTime() - PROPOSAL_TTL_DAYS * DAY_MS)
  })
})

describe('getAcceptedUnapplied / markProposalApplied', () => {
  it('возвращает ACCEPTED без payload.applied, отфильтровывает применённые', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'a1', status: 'ACCEPTED', payload: { phrases: ['x'] } },
      { id: 'a2', status: 'ACCEPTED', payload: { phrases: ['y'], applied: true } },
      { id: 'a3', status: 'ACCEPTED', payload: null },
    ])
    const rows = await getAcceptedUnapplied()
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a3'])
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACCEPTED' } })
    )
  })

  it('markProposalApplied сохраняет payload и ставит applied=true', async () => {
    mockFindUnique.mockResolvedValue({ id: 'a1', payload: { phrases: ['x'] } })
    mockUpdate.mockResolvedValue({})
    await markProposalApplied('a1')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { payload: { phrases: ['x'], applied: true } },
    })
  })

  it('markProposalApplied: предложение не найдено → тихо выходим', async () => {
    mockFindUnique.mockResolvedValue(null)
    await markProposalApplied('ghost')
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('formatProposalSummary', () => {
  it('minus_words: количество + первые 5 с многоточием', () => {
    const phrases = ['а', 'б', 'в', 'г', 'д', 'е', 'ж']
    expect(formatProposalSummary('minus_words', { phrases })).toBe(
      'Минус-фразы: 7 шт: а, б, в, г, д…'
    )
  })

  it('реальный драфт из brain-кода через formatProposalSummary → счётчик = длине phrases', () => {
    // Не рукописный объект: тот же билдер, что зовёт runProcessTick (единая форма payload).
    const draft = buildDisputedMinusProposalDraft(
      ['фабрика обедов павловский посад'],
      [{ candidate: 'фабрика обедов павловский посад', verdict: 'keep', reason: 'спорный' }],
      new Map([['фабрика обедов павловский посад', { impressions: 31, clicks: 0, costRub: 0 }]]),
    )
    expect(formatProposalSummary(draft.type, draft.payload)).toBe(
      'Минус-фразы: 1 шт: фабрика обедов павловский посад'
    )
  })

  it('budget: рубли из dailyBudgetRub или amountMicro', () => {
    expect(formatProposalSummary('budget', { dailyBudgetRub: 3500 })).toBe(
      'Дневной бюджет: 3500 ₽'
    )
    expect(formatProposalSummary('budget', { amountMicro: 3000_000_000 })).toBe(
      'Дневной бюджет: 3000 ₽'
    )
  })

  it('lift_minus_gate и дефолт', () => {
    expect(formatProposalSummary('lift_minus_gate', {})).toBe('Снять гейт спорных минусов')
    expect(formatProposalSummary('strategy', {})).toBe('strategy')
  })
})
