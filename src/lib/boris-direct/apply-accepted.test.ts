import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BorisDirectProposal } from '@prisma/client'

const { mockGetAccepted, mockMarkApplied, mockApplyNegatives, mockApplyBudget, mockPrepare } =
  vi.hoisted(() => ({
    mockGetAccepted: vi.fn(),
    mockMarkApplied: vi.fn(),
    mockApplyNegatives: vi.fn(),
    mockApplyBudget: vi.fn(),
    mockPrepare: vi.fn(),
  }))

vi.mock('./proposals', () => ({
  getAcceptedUnapplied: mockGetAccepted,
  markProposalApplied: mockMarkApplied,
}))
vi.mock('./write-gate', () => ({
  applyNegativeKeywords: mockApplyNegatives,
  applyDailyBudget: mockApplyBudget,
}))
vi.mock('./rules', () => ({ prepareMinusCandidates: mockPrepare }))

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
  mockApplyNegatives.mockResolvedValue({ applied: true, logId: 'log1' })
  mockApplyBudget.mockResolvedValue({ applied: true, logId: 'log2' })
  mockPrepare.mockImplementation((phrases: string[]) => ({ accepted: phrases, rejected: [] }))
})

describe('applyAcceptedProposals', () => {
  it('нет принятых → пустой результат, гейт не звали', async () => {
    const result = await applyAcceptedProposals()
    expect(result).toEqual({ applied: [], skipped: [] })
    expect(mockApplyNegatives).not.toHaveBeenCalled()
    expect(mockApplyBudget).not.toHaveBeenCalled()
  })

  describe('minus_words', () => {
    it('механика прогоняется с пустым ядром (владелец уже решил) → applyNegativeKeywords → markProposalApplied', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      const result = await applyAcceptedProposals()

      expect(mockPrepare).toHaveBeenCalledWith(['чужое кафе', 'вакансии повар'], {
        coreKeywords: [],
        existingMinus: [],
      })
      expect(mockApplyNegatives).toHaveBeenCalledWith(
        ['чужое кафе', 'вакансии повар'],
        [],
        'принято владельцем: предложение p1'
      )
      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.applied).toHaveLength(1)
      expect(result.applied[0]).toContain('минус-фразы (2)')
      expect(result.skipped).toEqual([])
    })

    it('OBSERVE (gate applied=false) → ВСЁ РАВНО markProposalApplied, отражено в skipped', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockApplyNegatives.mockResolvedValue({ applied: false, logId: 'log1' })
      const result = await applyAcceptedProposals()

      expect(mockMarkApplied).toHaveBeenCalledWith('p1')
      expect(result.applied).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]).toContain('сделал бы')
    })

    it('все кандидаты отсеяны механикой → гейт не зовём, помечаем и говорим в skipped', async () => {
      mockGetAccepted.mockResolvedValue([proposal()])
      mockPrepare.mockReturnValue({ accepted: [], rejected: [{ phrase: 'чужое кафе', reason: 'дубль' }] })
      const result = await applyAcceptedProposals()

      expect(mockApplyNegatives).not.toHaveBeenCalled()
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
    expect(mockApplyNegatives).not.toHaveBeenCalled()
    expect(mockApplyBudget).not.toHaveBeenCalled()
    expect(result).toEqual({ applied: [], skipped: [] })
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
    mockApplyNegatives.mockRejectedValue(new Error('Директ лёг'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await applyAcceptedProposals()

    // Первое упало ДО markProposalApplied → останется на следующий тик.
    expect(mockMarkApplied).not.toHaveBeenCalledWith('p1')
    expect(mockMarkApplied).toHaveBeenCalledWith('p2')
    expect(result.applied).toEqual(['дневной бюджет: 3000 ₽'])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('ошибка применения')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
