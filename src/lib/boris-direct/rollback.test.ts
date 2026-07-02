import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Откат последнего действия: лог читаем из мокнутой prisma, обратные
 * операции уходят в мокнутый write-gate (мимо гейта откат не ходит).
 */

const { mockPrisma, mockGate } = vi.hoisted(() => ({
  mockPrisma: {
    borisDirectActionLog: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockGate: {
    applyBidChanges: vi.fn(),
    applyNegativeKeywords: vi.fn(),
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('./write-gate', () => mockGate)

import { revertLastAction } from './rollback'
import { MICRO } from './config'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.borisDirectActionLog.update.mockResolvedValue({})
  mockGate.applyBidChanges.mockResolvedValue({
    applied: true,
    logId: 'revert-log',
    clamped: 0,
    breakerTripped: false,
  })
  mockGate.applyNegativeKeywords.mockResolvedValue({ applied: true, logId: 'revert-log' })
})

describe('revertLastAction', () => {
  it('нет подходящей записи → ok=false «откатывать нечего»', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue(null)

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(res.message).toContain('нечего')
    // Ищем только применённые, неоткаченные, из известного набора действий.
    const where = mockPrisma.borisDirectActionLog.findFirst.mock.calls[0][0].where
    expect(where.applied).toBe(true)
    expect(where.revertedAt).toBeNull()
  })

  it('keywordbids.set → applyBidChanges с обратными ставками и revertOfId, исходник помечен revertedAt', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-1',
      action: 'keywordbids.set',
      before: [{ keywordId: 11, bidMicro: 100 * MICRO }],
      after: [{ keywordId: 11, bidMicro: 150 * MICRO }],
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(true)
    expect(mockGate.applyBidChanges).toHaveBeenCalledWith(
      [{ keywordId: 11, fromMicro: 150 * MICRO, toMicro: 100 * MICRO }],
      'откат по команде владельца',
      'orig-1'
    )
    expect(mockPrisma.borisDirectActionLog.update).toHaveBeenCalledWith({
      where: { id: 'orig-1' },
      data: { revertedAt: expect.any(Date) },
    })
  })

  it('campaigns.update.negatives → applyNegativeKeywords(before, after) + revertedAt', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-2',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(true)
    expect(mockGate.applyNegativeKeywords).toHaveBeenCalledWith(
      ['старый'],
      ['старый', 'новый'],
      'откат по команде владельца',
      'orig-2'
    )
    expect(mockPrisma.borisDirectActionLog.update).toHaveBeenCalledWith({
      where: { id: 'orig-2' },
      data: { revertedAt: expect.any(Date) },
    })
  })

  it.each(['keywords.suspend', 'campaigns.suspend'])(
    '%s не откатываем автоматически (resume вне набора операций)',
    async (action) => {
      mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({ id: 'x', action })

      const res = await revertLastAction()

      expect(res.ok).toBe(false)
      expect(res.message).toContain(action)
      expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
      expect(mockGate.applyNegativeKeywords).not.toHaveBeenCalled()
      expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
    }
  )

  it('гейт не применил откат (observe/стоп-кран) → ok=false, revertedAt НЕ ставим', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-3',
      action: 'campaigns.update.negatives',
      before: [],
      after: ['новый'],
    })
    mockGate.applyNegativeKeywords.mockResolvedValue({ applied: false, logId: 'l' })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
  })

  it('битые before/after в логе → честный отказ без вызова гейта', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-4',
      action: 'keywordbids.set',
      before: { corrupted: true },
      after: null,
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
  })

  it('circuit breaker при откате ставок → ok=false', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-5',
      action: 'keywordbids.set',
      before: [{ keywordId: 1, bidMicro: 100 * MICRO }],
      after: [{ keywordId: 1, bidMicro: 150 * MICRO }],
    })
    mockGate.applyBidChanges.mockResolvedValue({
      applied: false,
      logId: 'l',
      clamped: 0,
      breakerTripped: true,
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(res.message).toContain('breaker')
    expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
  })
})
