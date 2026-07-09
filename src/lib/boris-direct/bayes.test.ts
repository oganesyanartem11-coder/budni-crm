import { describe, it, expect } from 'vitest'
import {
  binomialZeroLeadsProb,
  betaTailBelow,
  phraseBidVerdict,
} from './bayes'
import { VERDICT_CR_THRESHOLD_FRAC } from './config'

describe('binomialZeroLeadsProb — сверка с числами аудита (точная бинома)', () => {
  it('P(0 заявок | N кликов, CR) = (1−CR)^N', () => {
    expect(binomialZeroLeadsProb(20, 0.05)).toBeCloseTo(0.358, 2)
    expect(binomialZeroLeadsProb(20, 0.1)).toBeCloseTo(0.122, 2)
    expect(binomialZeroLeadsProb(20, 0.13)).toBeCloseTo(0.062, 2)
    // Симметрично: P(≥1 заявка | 10 кликов, CR 2%) = 1 − 0.98^10 ≈ 0.183.
    expect(1 - binomialZeroLeadsProb(10, 0.02)).toBeCloseTo(0.183, 2)
  })
})

describe('betaTailBelow — нормальная аппроксимация P(X<t) для Beta', () => {
  it('симметричный Beta(a,a): P(X<0.5)=0.5', () => {
    expect(betaTailBelow(0.5, 10, 10)).toBeCloseTo(0.5, 2)
  })
  it('масса выше порога → малый хвост; ниже → большой', () => {
    expect(betaTailBelow(0.05, 3, 20)).toBeLessThan(0.5) // mean ~13% > 5%
    expect(betaTailBelow(0.05, 1, 60)).toBeGreaterThan(0.7) // mean ~1.6% < 5%
  })
  it('вырожденные входы не падают', () => {
    expect(betaTailBelow(0.05, 0, 10)).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(betaTailBelow(0.05, 5, 5))).toBe(true)
  })
})

describe('phraseBidVerdict — асимметричные вердикты (гистерезис)', () => {
  const CR = 0.11 // CR кампании ~11%

  it('ТОНКАЯ фраза (0 данных) → promote (posterior≈prior выше порога) — встроенный exploration, НЕ hold', () => {
    const v = phraseBidVerdict({ leads: 0, clicks: 0, campaignCr: CR })
    expect(v.verdict).toBe('promote')
  })

  it('20 кликов, 0 заявок при CR кампании → HOLD (не демоутим уверенно — ключевой анти-ложный-приговор аудита)', () => {
    const v = phraseBidVerdict({ leads: 0, clicks: 20, campaignCr: CR })
    expect(v.verdict).toBe('hold')
  })

  it('40 кликов, 0 заявок → demote (данных хватает, уверенно горелка)', () => {
    const v = phraseBidVerdict({ leads: 0, clicks: 40, campaignCr: CR })
    expect(v.verdict).toBe('demote')
  })

  it('есть заявка (10 кликов, 1 заявка) → promote (конвертер-кандидат)', () => {
    const v = phraseBidVerdict({ leads: 1, clicks: 10, campaignCr: CR })
    expect(v.verdict).toBe('promote')
  })

  it('асимметрия гасит пилу: фраза в hold-зоне не дёргается туда-сюда (демоушен строже промоушена)', () => {
    // 25 кликов 0 заявок: между промоушеном и демоушеном → hold (не перескакивает).
    const v = phraseBidVerdict({ leads: 0, clicks: 25, campaignCr: CR })
    expect(v.verdict).toBe('hold')
    expect(v.pBelow).toBeGreaterThan(0.5) // уже не промоушен
    expect(v.pBelow).toBeLessThan(0.8) // но ещё не демоушен
  })

  it('порог из config — доля CR кампании (относительный)', () => {
    expect(VERDICT_CR_THRESHOLD_FRAC).toBe(0.5)
  })

  it('относительный порог: конвертер при НИЗКОМ CR кампании (4%) → promote (не «ниже 5% абсолютных»)', () => {
    // Ключ конвертит на уровне кампании (1 заявка/25 кликов = 4%); при абсолютном
    // пороге 5% он был бы «ниже порога», при относительном (0.5×4%=2%) — promote.
    const v = phraseBidVerdict({ leads: 1, clicks: 25, campaignCr: 0.04 })
    expect(v.verdict).toBe('promote')
  })
})
