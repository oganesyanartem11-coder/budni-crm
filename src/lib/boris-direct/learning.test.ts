import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LEARNING_WINDOW } from './config'

const { mockCreateMany, mockUpdateMany, mockFindMany } = vi.hoisted(() => ({
  mockCreateMany: vi.fn(),
  mockUpdateMany: vi.fn(),
  mockFindMany: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectMinusVerdict: {
      createMany: mockCreateMany,
      updateMany: mockUpdateMany,
      findMany: mockFindMany,
    },
  },
}))

import {
  recordVerdicts,
  recordOwnerDecision,
  getLearningStats,
  shouldOfferGateLift,
  buildGateLiftProposalInput,
  type LearningStats,
} from './learning'

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateMany.mockResolvedValue({ count: 0 })
  mockUpdateMany.mockResolvedValue({ count: 0 })
})

describe('recordVerdicts', () => {
  it('createMany с proposalId на каждой записи', async () => {
    await recordVerdicts(
      [
        { candidate: 'бесплатно', verdict: 'minus', reason: 'не наша аудитория' },
        { candidate: 'обед в офис', verdict: 'keep', reason: 'целевой' },
      ],
      'prop1'
    )
    expect(mockCreateMany).toHaveBeenCalledWith({
      data: [
        {
          candidate: 'бесплатно',
          verdict: 'minus',
          reason: 'не наша аудитория',
          proposalId: 'prop1',
        },
        { candidate: 'обед в офис', verdict: 'keep', reason: 'целевой', proposalId: 'prop1' },
      ],
    })
  })

  it('пустой список → БД не трогаем', async () => {
    await recordVerdicts([], null)
    expect(mockCreateMany).not.toHaveBeenCalled()
  })
})

describe('recordOwnerDecision — matched-логика по веткам verdict', () => {
  it('approved=true: minus → matched:true, keep → matched:false', async () => {
    await recordOwnerDecision('prop1', true)
    expect(mockUpdateMany).toHaveBeenCalledTimes(2)
    const [minusCall, keepCall] = mockUpdateMany.mock.calls
    expect(minusCall[0].where).toEqual({ proposalId: 'prop1', verdict: 'minus' })
    expect(minusCall[0].data).toMatchObject({ ownerDecision: 'approved', matched: true })
    expect(minusCall[0].data.decidedAt).toBeInstanceOf(Date)
    expect(keepCall[0].where).toEqual({ proposalId: 'prop1', verdict: 'keep' })
    expect(keepCall[0].data).toMatchObject({ ownerDecision: 'approved', matched: false })
  })

  it('approved=false: minus → matched:false, keep → matched:true', async () => {
    await recordOwnerDecision('prop2', false)
    const [minusCall, keepCall] = mockUpdateMany.mock.calls
    expect(minusCall[0].data).toMatchObject({ ownerDecision: 'rejected', matched: false })
    expect(keepCall[0].data).toMatchObject({ ownerDecision: 'rejected', matched: true })
  })
})

describe('getLearningStats', () => {
  it('нет решённых → decided 0, matchRate null, streak 0', async () => {
    mockFindMany.mockResolvedValue([])
    expect(await getLearningStats()).toEqual({ decided: 0, matchRate: null, streak: 0 })
  })

  it('streak считается с самой свежей, matchRate — доля matched', async () => {
    // desc-порядок: свежие первыми
    mockFindMany.mockResolvedValue([
      { matched: true },
      { matched: true },
      { matched: false },
      { matched: true },
    ])
    const stats = await getLearningStats()
    expect(stats.decided).toBe(4)
    expect(stats.matchRate).toBeCloseTo(0.75)
    expect(stats.streak).toBe(2)
  })

  it('самая свежая не совпала → streak 0', async () => {
    mockFindMany.mockResolvedValue([{ matched: false }, { matched: true }])
    const stats = await getLearningStats()
    expect(stats.streak).toBe(0)
    expect(stats.matchRate).toBeCloseTo(0.5)
  })

  it('окно = LEARNING_WINDOW, только решённые, orderBy decidedAt desc', async () => {
    mockFindMany.mockResolvedValue([])
    const now = new Date('2026-07-02T12:00:00Z')
    await getLearningStats(now)
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { decidedAt: { not: null, lte: now } },
      orderBy: { decidedAt: 'desc' },
      take: LEARNING_WINDOW,
    })
  })
})

describe('shouldOfferGateLift — пороги streak≥10 и accuracy≥0.99', () => {
  const stats = (streak: number, matchRate: number | null): LearningStats => ({
    decided: 30,
    matchRate,
    streak,
  })

  it('10 подряд при 100% совпадений → true', () => {
    expect(shouldOfferGateLift(stats(10, 1))).toBe(true)
  })

  it('9 подряд → false (streak-порог)', () => {
    expect(shouldOfferGateLift(stats(9, 1))).toBe(false)
  })

  it('matchRate 0.98 → false (accuracy-порог)', () => {
    expect(shouldOfferGateLift(stats(15, 0.98))).toBe(false)
  })

  it('matchRate null → false', () => {
    expect(shouldOfferGateLift(stats(15, null))).toBe(false)
  })
})

describe('buildGateLiftProposalInput', () => {
  it('type/topicKey lift_minus_gate, в аргументе streak и окно, в вопросе команда возврата', () => {
    const input = buildGateLiftProposalInput({ decided: 30, matchRate: 1, streak: 12 })
    expect(input.type).toBe('lift_minus_gate')
    expect(input.topicKey).toBe('lift_minus_gate')
    expect(input.argument).toContain('12')
    expect(input.argument).toContain('100%')
    expect(input.argument).toContain(String(LEARNING_WINDOW))
    expect(input.question).toContain('Борис, верни гейт')
    expect(input.payload).toMatchObject({ streak: 12, window: LEARNING_WINDOW })
  })
})
