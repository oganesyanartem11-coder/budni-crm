/**
 * М5 ШАГ 3: «эффект первой порции» — когорта поднятых 10.07 (A) vs остальной
 * портфель (B), метрики до/после. Тесты ЧИСТЫХ функций: выделение поднятых
 * ключей из ActionLog, разбивка метрик по когортам, честность малых данных.
 */

import { describe, it, expect } from 'vitest'
import {
  raisedKeywordIdsFromLogs,
  buildCohortStats,
  cohortHasEnoughData,
  type CriterionStat,
} from './cohorts'

describe('raisedKeywordIdsFromLogs: поднятые ключи из применённых логов', () => {
  it('берёт только keywordId, где after.bid > before.bid, и только applied', () => {
    const ids = raisedKeywordIdsFromLogs([
      {
        applied: true,
        before: [{ keywordId: 1, bidMicro: 50_000_000 }, { keywordId: 2, bidMicro: 100_000_000 }],
        after: [{ keywordId: 1, bidMicro: 95_000_000 }, { keywordId: 2, bidMicro: 100_000_000 }], // 1 поднят, 2 без изменений
      },
      {
        applied: true,
        before: [{ keywordId: 3, bidMicro: 200_000_000 }],
        after: [{ keywordId: 3, bidMicro: 150_000_000 }], // понижение — не в когорту
      },
    ])
    expect([...ids].sort()).toEqual([1])
  })

  it('неприменённые логи (applied=false) игнорирует', () => {
    const ids = raisedKeywordIdsFromLogs([
      {
        applied: false,
        before: [{ keywordId: 7, bidMicro: 50_000_000 }],
        after: [{ keywordId: 7, bidMicro: 95_000_000 }],
      },
    ])
    expect(ids.size).toBe(0)
  })

  it('кривой payload (не массивы) → пусто, не падает', () => {
    expect(raisedKeywordIdsFromLogs([{ applied: true, before: null, after: 'x' }]).size).toBe(0)
  })
})

describe('buildCohortStats: разбивка метрик по когортам', () => {
  const before = new Map<number, CriterionStat>([
    [1, { impressions: 100, clicks: 10, costRub: 500, conversions: 1 }],
    [2, { impressions: 200, clicks: 20, costRub: 1000, conversions: 0 }],
    [9, { impressions: 300, clicks: 30, costRub: 1500, conversions: 2 }], // не в A
  ])
  const after = new Map<number, CriterionStat>([
    [1, { impressions: 150, clicks: 18, costRub: 900, conversions: 2 }],
    [2, { impressions: 220, clicks: 22, costRub: 1200, conversions: 1 }],
    [9, { impressions: 320, clicks: 33, costRub: 1600, conversions: 2 }],
  ])
  const cohortA = new Set([1, 2])

  it('суммирует по членству; когорта A — поднятые, B — остальные', () => {
    const stats = buildCohortStats(cohortA, before, after, 5, 2)
    // A before: clicks 10+20=30, spend 500+1000=1500
    expect(stats.cohortA.before.clicks).toBe(30)
    expect(stats.cohortA.before.spendRub).toBe(1500)
    expect(stats.cohortA.before.keywords).toBe(2)
    // A after: clicks 18+22=40, conversions 2+1=3
    expect(stats.cohortA.after.clicks).toBe(40)
    expect(stats.cohortA.after.conversions).toBe(3)
    // B (id 9): before clicks 30, after clicks 33
    expect(stats.cohortB.before.clicks).toBe(30)
    expect(stats.cohortB.after.clicks).toBe(33)
    // окно в днях проброшено
    expect(stats.cohortA.before.days).toBe(5)
    expect(stats.cohortA.after.days).toBe(2)
  })

  it('ключ только в after (появился) → в B если не в A', () => {
    const stats = buildCohortStats(new Set([1]), before, after, 5, 2)
    // B = {2, 9}: after clicks 22+33=55
    expect(stats.cohortB.after.clicks).toBe(55)
  })
})

describe('cohortHasEnoughData: честность малых данных', () => {
  const mk = (clicks: number) => ({
    keywords: 39,
    clicks,
    impressions: 0,
    spendRub: 0,
    conversions: 0,
    days: 2,
  })
  it('after-клики когорты A < порога → мало данных', () => {
    expect(cohortHasEnoughData({ before: mk(0), after: mk(10) }, 30)).toBe(false)
  })
  it('after-клики ≥ порога → данных достаточно', () => {
    expect(cohortHasEnoughData({ before: mk(0), after: mk(30) }, 30)).toBe(true)
  })
})
