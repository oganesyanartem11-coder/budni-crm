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
    removeNegativeKeywords: vi.fn(),
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
  mockGate.removeNegativeKeywords.mockResolvedValue({
    applied: true,
    logId: 'revert-log',
    aborted: false,
    removed: 1,
  })
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

  it('B: campaigns.update.negatives → removeNegativeKeywords(added = after − before) из ЖИВОГО списка + revertedAt', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-2',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(true)
    // Удаляем ровно ДОБАВЛЕННОЕ действием («новый»), а не заливаем before целиком.
    expect(mockGate.removeNegativeKeywords).toHaveBeenCalledWith(
      ['новый'],
      'откат по команде владельца',
      'orig-2'
    )
    expect(mockPrisma.borisDirectActionLog.update).toHaveBeenCalledWith({
      where: { id: 'orig-2' },
      data: { revertedAt: expect.any(Date) },
    })
  })

  it('B: fail-safe отката (removeNegativeKeywords aborted) → ok=false, revertedAt НЕ ставим', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-6',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })
    mockGate.removeNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: null,
      aborted: true,
      abortReason: 'живой минус-список кабинета не прочитан',
      removed: 0,
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(res.message).toContain('не прочитан')
    expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
  })

  it('B: добавленных фраз в живом списке уже нет (removed=0) → ok=true, действие помечаем откаченным', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-7',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })
    mockGate.removeNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: null,
      aborted: false,
      removed: 0,
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(true)
    expect(res.message).toContain('уже')
    expect(mockPrisma.borisDirectActionLog.update).toHaveBeenCalledWith({
      where: { id: 'orig-7' },
      data: { revertedAt: expect.any(Date) },
    })
  })

  it('B/A: write отката минусов вернул ошибки API (writeErrors) → ok=false, revertedAt НЕ ставим', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-8',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })
    mockGate.removeNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: 'l',
      aborted: false,
      removed: 1,
      writeErrors: ['8000: Некорректная минус-фраза'],
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(res.message).toContain('8000')
    expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
  })

  it.each(['keywords.suspend', 'campaigns.suspend'])(
    '%s не откатываем автоматически (resume вне набора операций)',
    async (action) => {
      mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({ id: 'x', action })

      const res = await revertLastAction()

      expect(res.ok).toBe(false)
      expect(res.message).toContain(action)
      expect(mockGate.applyBidChanges).not.toHaveBeenCalled()
      expect(mockGate.removeNegativeKeywords).not.toHaveBeenCalled()
      expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
    }
  )

  it('откат минусов не применён (observe/стоп-кран, applied=false, removed>0) → ok=false, revertedAt НЕ ставим', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-3',
      action: 'campaigns.update.negatives',
      before: ['старый'],
      after: ['старый', 'новый'],
    })
    mockGate.removeNegativeKeywords.mockResolvedValue({
      applied: false,
      logId: 'l',
      aborted: false,
      removed: 1,
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(mockPrisma.borisDirectActionLog.update).not.toHaveBeenCalled()
  })

  it('A: write отката СТАВОК вернул ошибки (writeErrors, applied=false) → ok=false с текстом ошибки, revertedAt НЕ ставим', async () => {
    mockPrisma.borisDirectActionLog.findFirst.mockResolvedValue({
      id: 'orig-9',
      action: 'keywordbids.set',
      before: [{ keywordId: 1, bidMicro: 100 * MICRO }],
      after: [{ keywordId: 1, bidMicro: 150 * MICRO }],
    })
    mockGate.applyBidChanges.mockResolvedValue({
      applied: false,
      logId: 'l',
      clamped: 0,
      breakerTripped: false,
      writeErrors: ['5005: Неверный параметр'],
    })

    const res = await revertLastAction()

    expect(res.ok).toBe(false)
    expect(res.message).toContain('5005')
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
