import { describe, it, expect } from 'vitest'

/** Детекция аномалий — чистые функции, проверяем каждую ветку. */

import { detectAnomalies, isCatastrophe, type AnomalyInput } from './anomalies'

/** Спокойный день: ни одна проверка не срабатывает. */
function makeInput(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
  return {
    spentYesterdayRub: 1000,
    avgSpend7dRub: 900,
    impressionsYesterday: 400,
    avgImpressions7d: 380,
    addMetricaTag: 'YES',
    leadsYesterday: 2,
    avgLeads7d: 2,
    rejectedAdsCount: 0,
    apiErrors: [],
    ...overrides,
  }
}

describe('detectAnomalies', () => {
  it('спокойный день → пусто', () => {
    expect(detectAnomalies(makeInput())).toEqual([])
  })

  it('скачок расхода (вчера > 2× среднего) → critical', () => {
    const res = detectAnomalies(makeInput({ spentYesterdayRub: 2500, avgSpend7dRub: 1000 }))
    expect(res).toContainEqual(expect.objectContaining({ severity: 'critical', kind: 'spend_spike' }))
  })

  it('расход ровно ×2 — ещё не скачок; среднее 0 или null — проверка молчит', () => {
    expect(detectAnomalies(makeInput({ spentYesterdayRub: 2000, avgSpend7dRub: 1000 }))).toEqual([])
    expect(detectAnomalies(makeInput({ spentYesterdayRub: 9999, avgSpend7dRub: 0 }))).toEqual([])
    expect(detectAnomalies(makeInput({ spentYesterdayRub: 9999, avgSpend7dRub: null }))).toEqual([])
  })

  it('обрыв показов (вчера < 20% среднего при avg ≥ 50) → critical', () => {
    const res = detectAnomalies(makeInput({ impressionsYesterday: 5, avgImpressions7d: 100 }))
    expect(res).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'impressions_drop' })
    )
  })

  it('среднее показов < 50 → обрыв не меряем (мало данных)', () => {
    expect(detectAnomalies(makeInput({ impressionsYesterday: 0, avgImpressions7d: 40 }))).toEqual([])
  })

  it("ADD_METRICA_TAG='NO' → critical", () => {
    const res = detectAnomalies(makeInput({ addMetricaTag: 'NO' }))
    expect(res).toContainEqual(
      expect.objectContaining({ severity: 'critical', kind: 'metrica_tag_off' })
    )
  })

  it('тег неизвестен (null) → молчим', () => {
    expect(detectAnomalies(makeInput({ addMetricaTag: null }))).toEqual([])
  })

  it('заявки упали в ноль после того как были (avg7d ≥ 1) → warn', () => {
    const res = detectAnomalies(makeInput({ leadsYesterday: 0, avgLeads7d: 1.5 }))
    expect(res).toContainEqual(expect.objectContaining({ severity: 'warn', kind: 'leads_zero' }))
  })

  it('заявок и раньше не было (avg7d < 1) → не аномалия', () => {
    expect(detectAnomalies(makeInput({ leadsYesterday: 0, avgLeads7d: 0.5 }))).toEqual([])
    expect(detectAnomalies(makeInput({ leadsYesterday: 0, avgLeads7d: null }))).toEqual([])
  })

  it('REJECTED > 0 → warn', () => {
    const res = detectAnomalies(makeInput({ rejectedAdsCount: 3 }))
    expect(res).toContainEqual(expect.objectContaining({ severity: 'warn', kind: 'rejected' }))
  })

  it('apiErrors непустой → warn с текстами ошибок', () => {
    const res = detectAnomalies(makeInput({ apiErrors: ['keywords.get: HTTP 500'] }))
    const anomaly = res.find((a) => a.kind === 'api_errors')
    expect(anomaly?.severity).toBe('warn')
    expect(anomaly?.text).toContain('keywords.get: HTTP 500')
  })

  it('несколько аномалий сразу — все в списке', () => {
    const res = detectAnomalies(
      makeInput({ addMetricaTag: 'NO', rejectedAdsCount: 1, apiErrors: ['x'] })
    )
    expect(res.map((a) => a.kind).sort()).toEqual(['api_errors', 'metrica_tag_off', 'rejected'])
  })
})

describe('isCatastrophe', () => {
  it('расход сегодня > бюджет × 1.5 → катастрофа', () => {
    expect(isCatastrophe({ spentTodayRub: 4501, dailyBudgetRub: 3000 })).toBe(true)
  })

  it('ровно ×1.5 и ниже → не катастрофа', () => {
    expect(isCatastrophe({ spentTodayRub: 4500, dailyBudgetRub: 3000 })).toBe(false)
    expect(isCatastrophe({ spentTodayRub: 3000, dailyBudgetRub: 3000 })).toBe(false)
  })
})
