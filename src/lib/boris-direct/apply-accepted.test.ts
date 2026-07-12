import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BorisDirectProposal } from '@prisma/client'

const { mockGetAccepted, mockMarkApplied, mockAddNegatives, mockApplyBudget, mockPrepare, mockRevertActionById } =
  vi.hoisted(() => ({
    mockGetAccepted: vi.fn(),
    mockMarkApplied: vi.fn(),
    mockAddNegatives: vi.fn(),
    mockApplyBudget: vi.fn(),
    mockPrepare: vi.fn(),
    mockRevertActionById: vi.fn(),
  }))

vi.mock('./proposals', () => ({
  getAcceptedUnapplied: mockGetAccepted,
  markProposalApplied: mockMarkApplied,
}))
vi.mock('./write-gate', () => ({
  addNegativeKeywords: mockAddNegatives,
  applyDailyBudget: mockApplyBudget,
}))
vi.mock('./rules', () => ({ prepareMinusCandidates: mockPrepare }))
vi.mock('./rollback', () => ({ revertActionById: mockRevertActionById }))

import { applyAcceptedProposals } from './apply-accepted'

const proposal = (over: Partial<BorisDirectProposal> = {}): BorisDirectProposal =>
  ({
    id: 'p1',
    type: 'minus_words',
    topicKey: 'minus_words',
    payload: { phrases: ['чужое кафе', 'вакансии повар'] },
    ...over,
  }) as BorisDirectProposal

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAccepted.mockResolvedValue([])
  mockMarkApplied.mockResolvedValue(undefined)
  mockAddNegatives.mockResolvedValue({
    applied: true,
    logId: 'log1',
    aborted: false,
    added: 2,
    addedPhrases: ['чужое кафе', 'вакансии повар'],
  })
  mockApplyBudget.mockResolvedValue({ applied: true, logId: 'log2' })
  mockPrepare.mockImplementation((phrases: string[]) => ({ accepted: phrases, rejected: [] }))
  mockRevertActionById.mockResolvedValue({ ok: true, message: 'откатил' })
})

describe('М4 ШАГ 5: принятые коррекции (bid_revert / minus_review)', () => {
  it('bid_revert → revertActionById(actionLogId) + applied, без «ручного применения»', async () => {
    mockGetAccepted.mockResolvedValue([
      proposal({ id: 'c1', type: 'bid_revert', payload: { actionLogId: 'act9' } }),
    ])
    mockRevertActionById.mockResolvedValue({ ok: true, message: 'Откатил ставки по 3 фразам.' })
    const result = await applyAcceptedProposals()
    expect(mockRevertActionById).toHaveBeenCalledWith('act9')
    expect(mockMarkApplied).toHaveBeenCalledWith('c1')
    expect(result.applied.some((s) => s.includes('Откатил ставки'))).toBe(true)
    expect(result.skipped.join(' ')).not.toContain('ручного применения')
  })

  it('minus_review → revertActionById(actionLogId) + applied', async () => {
    mockGetAccepted.mockResolvedValue([
      proposal({ id: 'c2', type: 'minus_review', payload: { actionLogId: 'act8' } }),
    ])
    mockRevertActionById.mockResolvedValue({ ok: true, message: 'Убрал 2 фразы.' })
    const result = await applyAcceptedProposals()
    expect(mockRevertActionById).toHaveBeenCalledWith('act8')
    expect(result.applied.some((s) => s.includes('Убрал'))).toBe(true)
  })

  it('коррекция не применилась (ok=false) → skipped с причиной, помечена applied (без петли)', async () => {
    mockGetAccepted.mockResolvedValue([
      proposal({ id: 'c3', type: 'bid_revert', payload: { actionLogId: 'act7' } }),
    ])
    mockRevertActionById.mockResolvedValue({ ok: false, message: 'CB не пропустил.' })
    const result = await applyAcceptedProposals()
    expect(mockMarkApplied).toHaveBeenCalledWith('c3')
    expect(result.skipped.some((s) => s.includes('CB не пропустил'))).toBe(true)
    expect(result.applied).toHaveLength(0)
  })

  it('bid_revert без actionLogId → skipped, revert не зовём', async () => {
    mockGetAccepted.mockResolvedValue([proposal({ id: 'c4', type: 'bid_revert', payload: {} })])
    const result = await applyAcceptedProposals()
    expect(mockRevertActionById).not.toHaveBeenCalled()
    expect(result.skipped.some((s) => s.includes('actionLogId'))).toBe(true)
  })
})

describe('applyAcceptedProposals', () => {
  it('нет принятых → пустой результат, гейт не звали', async () => {
    const result = await applyAcceptedProposals()
    expect(result).toEqual({ applied: [], skipped: [], alerts: [] })
    expect(mockAddNegatives).not.toHaveBeenCalled()
    expect(mockApplyBudget).not.toHaveBeenCalled()
  })

  describe('minus_words', () => {
    it('механика прогоняется с пустым ядром (владелец уже решил) → addNegativeKeywords (мерж с живым) → markProposalApplied', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      const result = await applyAcceptedProposals()

      expect(mockPrepare).toHaveBeenCalledWith(['чужое кафе', 'вакансии повар'], {
        coreKeywords: [],
        existingMinus: [],
      })
      // Через единую точку мержа — БЕЗ замещающего previousFullList (мерж внутри).
      expect(mockAddNegatives).toHaveBeenCalledWith(
        ['чужое кафе', 'вакансии повар'],
        'принято владельцем: предложение p1'
      )
      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.applied).toHaveLength(1)
      expect(result.applied[0]).toContain('минус-фразы (2)')
      expect(result.skipped).toEqual([])
      expect(result.alerts).toEqual([])
    })

    it('OBSERVE (gate applied=false) → ВСЁ РАВНО markProposalApplied, отражено в skipped', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockAddNegatives.mockResolvedValue({
        applied: false,
        logId: 'log1',
        aborted: false,
        added: 2,
        addedPhrases: ['чужое кафе', 'вакансии повар'],
      })
      const result = await applyAcceptedProposals()

      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.applied).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]).toContain('сделал бы')
    })

    it('FAIL-SAFE (aborted): НЕ помечаем применённым (повтор на след. тике) + алёрт владельцу', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockAddNegatives.mockResolvedValue({
        applied: false,
        logId: null,
        aborted: true,
        abortReason: 'живой минус-список кабинета не прочитан',
        added: 0,
      })
      const result = await applyAcceptedProposals()

      // НЕ помечаем — принятое предложение повторится, когда чтение восстановится.
      expect(mockMarkApplied).not.toHaveBeenCalledWith('p1')
      expect(result.applied).toEqual([])
      expect(result.alerts).toHaveLength(1)
      expect(result.alerts[0]).toContain('не прочитан')
      expect(result.skipped[0]).toContain('fail-safe')
    })

    it('A: write минусов провалился (writeErrors) → НЕ markProposalApplied (повтор), алёрт владельцу', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockAddNegatives.mockResolvedValue({
        applied: false,
        logId: 'log1',
        aborted: false,
        added: 2,
        addedPhrases: ['чужое кафе', 'вакансии повар'],
        writeErrors: ['8000: Некорректная минус-фраза'],
      })
      const result = await applyAcceptedProposals()

      // Провал write ≠ OBSERVE: не помечаем применённым (повторим на след. тике).
      expect(mockMarkApplied).not.toHaveBeenCalledWith('p1')
      expect(result.applied).toEqual([])
      expect(result.alerts).toHaveLength(1)
      expect(result.alerts[0]).toContain('8000')
      expect(result.skipped[0]).toContain('write')
    })

    it('D: счётчик и список — НЕТТО-новые (gate.added/addedPhrases), а не число принятых механикой', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockPrepare.mockReturnValue({ accepted: ['чужое кафе', 'вакансии повар'], rejected: [] })
      // Живой кабинет уже содержит «чужое кафе» → нетто-новая только одна.
      mockAddNegatives.mockResolvedValue({
        applied: true,
        logId: 'log1',
        aborted: false,
        added: 1,
        addedPhrases: ['вакансии повар'],
      })
      const result = await applyAcceptedProposals()

      expect(result.applied[0]).toContain('минус-фразы (1)')
      expect(result.applied[0]).toContain('вакансии повар')
      expect(result.applied[0]).not.toContain('чужое кафе')
    })

    it('verifyMismatch: применили, но контрольное чтение не сошлось → алёрт владельцу', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockAddNegatives.mockResolvedValue({
        applied: true,
        logId: 'log1',
        aborted: false,
        added: 2,
        addedPhrases: ['чужое кафе', 'вакансии повар'],
        verifyMismatch: true,
      })
      const result = await applyAcceptedProposals()

      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.applied).toHaveLength(1)
      expect(result.alerts).toHaveLength(1)
      expect(result.alerts[0]).toContain('контрольное чтение')
    })

    it('все кандидаты отсеяны механикой → гейт не зовём, помечаем и говорим в skipped', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockPrepare.mockReturnValue({ accepted: [], rejected: [{ phrase: 'чужое кафе', reason: 'дубль' }] })
      const result = await applyAcceptedProposals()

      expect(mockAddNegatives).not.toHaveBeenCalled()
      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.skipped[0]).toContain('отсеяны механикой')
    })
  })

  describe('budget', () => {
    it('amountMicro → applyDailyBudget с reason «явное да владельца» → markProposalApplied', async () => {
      mockGetAccepted.mockResolvedValue([
        proposal({ id: 'p2', type: 'budget', payload: { amountMicro: 3500_000_000 } }),
      ])
      const result = await applyAcceptedProposals()

      expect(mockApplyBudget).toHaveBeenCalledWith(3500_000_000, 'явное да владельца: предложение p2')
      expect(mockMarkApplied).toHaveBeenCalledWith('p2')
      expect(result.applied).toEqual(['дневной бюджет: 3500 ₽'])
    })

    it('битый payload (нет amountMicro) → бюджет НЕ трогаем, помечаем + skipped', async () => {
      mockGetAccepted.mockResolvedValue([proposal({ id: 'p2', type: 'budget', payload: {} })])
      const result = await applyAcceptedProposals()

      expect(mockApplyBudget).not.toHaveBeenCalled()
      expect(mockMarkApplied).toHaveBeenCalledWith('p2')
      expect(result.skipped[0]).toContain('требует ручного применения')
    })
  })

  it('lift_minus_gate: уже применён при клике → только markProposalApplied, ни в applied, ни в skipped', async () => {
    mockGetAccepted.mockResolvedValue([
      proposal({ id: 'p3', type: 'lift_minus_gate', payload: { streak: 10 } }),
    ])
    const result = await applyAcceptedProposals()

    expect(mockMarkApplied).toHaveBeenCalledWith('p3')
    expect(mockAddNegatives).not.toHaveBeenCalled()
    expect(mockApplyBudget).not.toHaveBeenCalled()
    expect(result).toEqual({ applied: [], skipped: [], alerts: [] })
  })

  it('неизвестный type → markProposalApplied + skipped «требует ручного применения»', async () => {
    mockGetAccepted.mockResolvedValue([proposal({ id: 'p4', type: 'mystery', payload: {} })])
    const result = await applyAcceptedProposals()

    expect(mockMarkApplied).toHaveBeenCalledWith('p4')
    expect(result.skipped).toEqual(['mystery: требует ручного применения (предложение p4)'])
  })

  it('ошибка одного предложения не роняет остальные; упавшее НЕ помечается applied', async () => {
    mockGetAccepted.mockResolvedValue([
      proposal({ id: 'p1' }),
      proposal({ id: 'p2', type: 'budget', payload: { amountMicro: 3000_000_000 } }),
    ])
    mockAddNegatives.mockRejectedValue(new Error('Директ лёг'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await applyAcceptedProposals()

    // Первое упало ДО markProposalApplied → останется на следующий тик.
    expect(mockMarkApplied).not.toHaveBeenCalledWith('p1')
    expect(mockMarkApplied).toHaveBeenCalledWith('p2')
    expect(result.applied).toEqual(['дневной бюджет: 3000 ₽'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('ошибка применения')
    // C: тихого отказа быть не должно — владельцу уходит алёрт с причиной.
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0]).toContain('p1')
    expect(result.alerts[0]).toContain('Директ лёг')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
