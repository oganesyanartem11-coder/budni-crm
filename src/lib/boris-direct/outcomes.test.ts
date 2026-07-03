import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OUTCOME_IMPROVED_RATIO,
  OUTCOME_MIN_CLICKS,
  OUTCOME_WINDOW_DAYS,
  OUTCOME_WORSE_RATIO,
} from './config'

/**
 * Исходы «до/после» (outcomes.ts). Prisma и createProposal замоканы —
 * без БД и Telegram. Арифметика вердиктов проверяется на цифрах,
 * выведенных из порогов config (не хардкод).
 */

const { mockActionLog, mockProposal, mockStat, mockCreateProposal } = vi.hoisted(() => ({
  mockActionLog: { findMany: vi.fn(), update: vi.fn() },
  mockProposal: { findMany: vi.fn(), update: vi.fn() },
  mockStat: { findMany: vi.fn() },
  mockCreateProposal: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectActionLog: mockActionLog,
    borisDirectProposal: mockProposal,
    borisDirectQueryDailyStat: mockStat,
  },
}))

vi.mock('./proposals', () => ({ createProposal: mockCreateProposal }))

import {
  measureActionOutcomes,
  measureProposalOutcomes,
  generateCorrectionProposals,
} from './outcomes'

const DAY_MS = 24 * 60 * 60 * 1000

// Фиксированное «сейчас» и созревшая точка отсчёта (старше окна на день).
const now = new Date('2026-07-03T12:00:00Z')
const anchor = new Date(now.getTime() - (OUTCOME_WINDOW_DAYS + 1) * DAY_MS)

interface StatRow {
  clicks: number
  costRub: number
  conversions: number
}

/** Окно ДО начинается раньше точки отсчёта — по этому и различаем запросы. */
function statWindows(anchorDate: Date, before: StatRow[], after: StatRow[]): void {
  mockStat.findMany.mockImplementation(
    async (args: { where: { date: { gte: Date } } }) =>
      args.where.date.gte.getTime() < anchorDate.getTime() ? before : after
  )
}

function actionLog(over: Record<string, unknown> = {}) {
  return {
    id: 'log1',
    action: 'keywordbids.set',
    targetType: 'campaign',
    targetId: null,
    applied: true,
    revertedAt: null,
    createdAt: anchor,
    outcomeVerdict: null,
    outcomeMeasuredAt: null,
    outcomeData: null,
    ...over,
  }
}

// Базовое окно ДО: 30 кликов, 10 заявок, cpl = 200.
const BEFORE: StatRow = { clicks: 30, costRub: 2000, conversions: 10 }
const CPL_BEFORE = BEFORE.costRub / BEFORE.conversions

beforeEach(() => {
  vi.clearAllMocks()
  mockActionLog.update.mockResolvedValue({})
  mockProposal.update.mockResolvedValue({})
  mockCreateProposal.mockResolvedValue({ created: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('measureActionOutcomes — вердикты', () => {
  it('мало кликов в окне ДО → unmeasurable (шум не интерпретируем)', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    statWindows(anchor, [{ clicks: OUTCOME_MIN_CLICKS - 1, costRub: 500, conversions: 5 }], [
      { clicks: 100, costRub: 2000, conversions: 10 },
    ])

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 0, unmeasurable: 1 })
    const { data } = mockActionLog.update.mock.calls[0][0]
    expect(data.outcomeVerdict).toBe('unmeasurable')
    expect(data.outcomeData.ratio).toBeNull()
  })

  it('ratio на пороге WORSE → worse', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    // cpl после = cpl до × OUTCOME_WORSE_RATIO
    const afterCost = BEFORE.costRub * OUTCOME_WORSE_RATIO
    statWindows(anchor, [BEFORE], [{ clicks: 30, costRub: afterCost, conversions: 10 }])

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 1, unmeasurable: 0 })
    expect(mockActionLog.update.mock.calls[0][0].data.outcomeVerdict).toBe('worse')
  })

  it('ratio на пороге IMPROVED → improved', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    const afterCost = BEFORE.costRub * OUTCOME_IMPROVED_RATIO
    statWindows(anchor, [BEFORE], [{ clicks: 30, costRub: afterCost, conversions: 10 }])

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 0, unmeasurable: 0 })
    expect(mockActionLog.update.mock.calls[0][0].data.outcomeVerdict).toBe('improved')
  })

  it('ratio между порогами → neutral', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    const middleRatio = (OUTCOME_IMPROVED_RATIO + OUTCOME_WORSE_RATIO) / 2
    const afterCost = BEFORE.costRub * middleRatio
    statWindows(anchor, [BEFORE], [{ clicks: 30, costRub: afterCost, conversions: 10 }])

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 0, unmeasurable: 0 })
    expect(mockActionLog.update.mock.calls[0][0].data.outcomeVerdict).toBe('neutral')
  })

  it('0 конверсий ПОСЛЕ при расходе, а ДО заявки были → worse', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    statWindows(anchor, [BEFORE], [{ clicks: 30, costRub: 1500, conversions: 0 }])

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 1, unmeasurable: 0 })
  })

  it('0 конверсий и ДО, и ПОСЛЕ → unmeasurable (сравнивать нечего)', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    statWindows(
      anchor,
      [{ clicks: 30, costRub: 2000, conversions: 0 }],
      [{ clicks: 30, costRub: 1500, conversions: 0 }]
    )

    const result = await measureActionOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 0, unmeasurable: 1 })
  })

  it('пишет outcomeData (before/after/ratio) и outcomeMeasuredAt=now', async () => {
    mockActionLog.findMany.mockResolvedValue([actionLog()])
    const afterCost = BEFORE.costRub * OUTCOME_WORSE_RATIO
    statWindows(anchor, [BEFORE], [{ clicks: 25, costRub: afterCost, conversions: 10 }])

    await measureActionOutcomes(now)

    expect(mockActionLog.update).toHaveBeenCalledWith({
      where: { id: 'log1' },
      data: {
        outcomeVerdict: 'worse',
        outcomeMeasuredAt: now,
        outcomeData: {
          before: { ...BEFORE, cpl: CPL_BEFORE },
          after: {
            clicks: 25,
            costRub: afterCost,
            conversions: 10,
            cpl: afterCost / 10,
          },
          ratio: afterCost / 10 / CPL_BEFORE,
        },
      },
    })
  })

  it('действие по группе (targetType adgroup) меряется по срезу adGroupId', async () => {
    mockActionLog.findMany.mockResolvedValue([
      actionLog({ targetType: 'adgroup', targetId: 'g42' }),
    ])
    statWindows(anchor, [BEFORE], [BEFORE])

    await measureActionOutcomes(now)

    for (const call of mockStat.findMany.mock.calls) {
      expect(call[0].where.adGroupId).toBe('g42')
    }
    expect(mockStat.findMany).toHaveBeenCalledTimes(2)
  })

  it('отбирает только applied без исхода и старше окна', async () => {
    mockActionLog.findMany.mockResolvedValue([])

    await measureActionOutcomes(now)

    expect(mockActionLog.findMany).toHaveBeenCalledWith({
      where: {
        applied: true,
        outcomeMeasuredAt: null,
        createdAt: { lt: new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('ошибка одной записи не роняет остальные', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockActionLog.findMany.mockResolvedValue([actionLog(), actionLog({ id: 'log2' })])
    statWindows(anchor, [BEFORE], [BEFORE])
    mockActionLog.update.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({})

    const result = await measureActionOutcomes(now)

    expect(result.measured).toBe(1)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('measureProposalOutcomes', () => {
  function proposal(over: Record<string, unknown> = {}) {
    return {
      id: 'p1',
      status: 'ACCEPTED',
      payload: { applied: true },
      decidedAt: anchor,
      outcomeMeasuredAt: null,
      ...over,
    }
  }

  it('меряет только применённые с decidedAt старше окна; остальные пропускает', async () => {
    mockProposal.findMany.mockResolvedValue([
      proposal({ id: 'skip-no-decision', decidedAt: null }),
      proposal({ id: 'skip-not-applied', payload: {} }),
      proposal({ id: 'skip-fresh', decidedAt: new Date(now.getTime() - DAY_MS) }),
      proposal({ id: 'p-ok' }),
    ])
    const afterCost = BEFORE.costRub * OUTCOME_WORSE_RATIO
    statWindows(anchor, [BEFORE], [{ clicks: 30, costRub: afterCost, conversions: 10 }])

    const result = await measureProposalOutcomes(now)

    expect(result).toEqual({ measured: 1, worse: 1, unmeasurable: 0 })
    expect(mockProposal.update).toHaveBeenCalledTimes(1)
    const call = mockProposal.update.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'p-ok' })
    expect(call.data.outcomeVerdict).toBe('worse')
    expect(call.data.outcomeMeasuredAt).toBe(now)
    expect(call.data.outcomeData.before.cpl).toBe(CPL_BEFORE)
  })

  it('берёт из БД только ACCEPTED без исхода', async () => {
    mockProposal.findMany.mockResolvedValue([])

    await measureProposalOutcomes(now)

    expect(mockProposal.findMany).toHaveBeenCalledWith({
      where: { status: 'ACCEPTED', outcomeMeasuredAt: null },
      orderBy: { decidedAt: 'asc' },
    })
  })
})

describe('generateCorrectionProposals — за флагом владельца', () => {
  const worseData = {
    before: { clicks: 30, costRub: 2000, conversions: 10, cpl: 200 },
    after: { clicks: 30, costRub: 2600, conversions: 10, cpl: 260 },
    ratio: 1.3,
  }

  it('флаг выключен → no-op, БД не трогаем', async () => {
    vi.stubEnv('BORIS_DIRECT_AUTO_CORRECTION', '')

    const result = await generateCorrectionProposals(now)

    expect(result).toEqual({ created: 0 })
    expect(mockActionLog.findMany).not.toHaveBeenCalled()
    expect(mockCreateProposal).not.toHaveBeenCalled()
  })

  it('флаг включён → bid_revert и minus_review по worse-исходам, счёт только created:true', async () => {
    vi.stubEnv('BORIS_DIRECT_AUTO_CORRECTION', 'true')
    mockActionLog.findMany.mockResolvedValue([
      actionLog({ id: 'log1', action: 'keywordbids.set', outcomeVerdict: 'worse', outcomeData: worseData }),
      actionLog({
        id: 'log2',
        action: 'campaigns.update.negatives',
        outcomeVerdict: 'worse',
        outcomeData: worseData,
      }),
      actionLog({ id: 'log3', action: 'keywords.suspend', outcomeVerdict: 'worse' }),
    ])
    mockCreateProposal
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false, reason: 'pending_exists' })

    const result = await generateCorrectionProposals(now)

    // Неизвестное действие log3 пропущено; создано только одно из двух.
    expect(result).toEqual({ created: 1 })
    expect(mockCreateProposal).toHaveBeenCalledTimes(2)

    const bidRevert = mockCreateProposal.mock.calls[0][0]
    expect(bidRevert).toMatchObject({
      type: 'bid_revert',
      topicKey: 'bid_revert_log1',
      payload: { actionLogId: 'log1' },
      question: 'Откатить ставки к прежним?',
    })
    // Аргумент — детерминированный текст с цифрами до/после из outcomeData.
    expect(bidRevert.argument).toContain('200')
    expect(bidRevert.argument).toContain('260')

    expect(mockCreateProposal.mock.calls[1][0]).toMatchObject({
      type: 'minus_review',
      topicKey: 'minus_review_log2',
      payload: { actionLogId: 'log2' },
      question: 'Пересмотреть этот минус-пакет?',
    })

    // Окно отбора: последние 2×OUTCOME_WINDOW_DAYS, worse, не откаченные.
    expect(mockActionLog.findMany).toHaveBeenCalledWith({
      where: {
        outcomeVerdict: 'worse',
        revertedAt: null,
        createdAt: { gte: new Date(now.getTime() - 2 * OUTCOME_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('worse без заявок после: аргумент говорит про расход без конверсий', async () => {
    vi.stubEnv('BORIS_DIRECT_AUTO_CORRECTION', 'true')
    mockActionLog.findMany.mockResolvedValue([
      actionLog({
        id: 'log9',
        action: 'keywordbids.set',
        outcomeVerdict: 'worse',
        outcomeData: {
          before: { clicks: 30, costRub: 2000, conversions: 10, cpl: 200 },
          after: { clicks: 30, costRub: 1500, conversions: 0, cpl: null },
          ratio: null,
        },
      }),
    ])

    await generateCorrectionProposals(now)

    const { argument } = mockCreateProposal.mock.calls[0][0]
    expect(argument).toContain('заявок нет')
    expect(argument).toContain('1500')
    expect(argument).toContain('200')
  })
})
