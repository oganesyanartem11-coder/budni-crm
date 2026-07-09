import { describe, it, expect } from 'vitest'
import { underspendGateOpen, recommendMarginalBid } from './underspend'
import { MICRO, BID_CEILING_MICRO } from './config'

describe('underspendGateOpen — газ по тренду, тормоз мгновенный', () => {
  const budget = 3000

  it('медиана окна < 80% бюджета И вчера < 95% → ОТКРЫТ (газ по тренду)', () => {
    const r = underspendGateOpen({
      recentDailySpendsRub: [1000, 1200, 900, 1400],
      yesterdaySpendRub: 1400,
      dailyBudgetRub: budget,
    })
    expect(r.open).toBe(true)
    expect(r.medianRub).toBeGreaterThan(0)
  })

  it('ВЧЕРА расход ≥ 95% бюджета → ЗАКРЫТ мгновенно (даже при низкой медиане)', () => {
    const r = underspendGateOpen({
      recentDailySpendsRub: [300, 400, 500, 2900], // медиана низкая
      yesterdaySpendRub: 2900, // ≥ 0.95×3000=2850 → тормоз
      dailyBudgetRub: budget,
    })
    expect(r.open).toBe(false)
    expect(r.reason).toMatch(/тормоз|вчера/i)
  })

  it('медиана ≥ 80% бюджета → ЗАКРЫТ (расход у нормы, газа не надо)', () => {
    const r = underspendGateOpen({
      recentDailySpendsRub: [2500, 2600, 2400, 2500], // медиана ~2500 ≥ 2400=0.8×3000
      yesterdaySpendRub: 2500,
      dailyBudgetRub: budget,
    })
    expect(r.open).toBe(false)
  })

  it('ГИСТЕРЕЗИС: медиана в полосе [80%,95%) — держит прежнее состояние (против осцилляции)', () => {
    const inBand = { recentDailySpendsRub: [2600, 2700, 2600, 2700], yesterdaySpendRub: 2700, dailyBudgetRub: 3000 } // медиана 2650 = 88%
    // Был закрыт → не открывается (88% ≥ 80% порога входа).
    expect(underspendGateOpen({ ...inBand, previouslyOpen: false }).open).toBe(false)
    // Был открыт → держится (88% < 95% порога удержания) — не захлопывается от собственного газа.
    expect(underspendGateOpen({ ...inBand, previouslyOpen: true }).open).toBe(true)
  })

  it('вчера ≥ 95% перекрывает гистерезис (мгновенный тормоз даже если был открыт)', () => {
    expect(
      underspendGateOpen({ recentDailySpendsRub: [500, 500, 500, 500], yesterdaySpendRub: 2900, dailyBudgetRub: 3000, previouslyOpen: true }).open
    ).toBe(false)
  })

  it('нет бюджета/данных → закрыт (fail-safe)', () => {
    expect(underspendGateOpen({ recentDailySpendsRub: [1000], yesterdaySpendRub: 1000, dailyBudgetRub: 0 }).open).toBe(false)
    expect(underspendGateOpen({ recentDailySpendsRub: [], yesterdaySpendRub: null, dailyBudgetRub: 3000 }).open).toBe(false)
  })
})

describe('recommendMarginalBid — максимальный TV под E[CPL]-cap ≤ вето/потолка', () => {
  // Лесенка: TV65=95₽, TV75=104₽, TV80=108₽ (не премиум); TV85+=премиум (вето).
  const ladder = [
    { TrafficVolume: 65, Bid: 100 * MICRO, Price: 95 * MICRO },
    { TrafficVolume: 75, Bid: 110 * MICRO, Price: 104 * MICRO },
    { TrafficVolume: 80, Bid: 115 * MICRO, Price: 108 * MICRO },
    { TrafficVolume: 85, Bid: 700 * MICRO, Price: 650 * MICRO }, // премиум — вето
    { TrafficVolume: 100, Bid: 900 * MICRO, Price: 850 * MICRO },
  ]

  it('сильный конвертер (CR 11%) при cap 10%×20000=2000 → максимальный НЕ-премиум TV80 (E[CPL]=982<2000)', () => {
    const r = recommendMarginalBid({
      auctionBids: ladder, posteriorCr: 0.11, leadValueRub: 20000, cplCapPct: 0.1, currentBidMicro: 100 * MICRO,
    })
    expect(r.changed).toBe(true)
    expect(r.targetTv).toBe(80) // не 85 (премиум-вето)
    expect(r.targetBidMicro).toBe(115 * MICRO)
  })

  it('низкий posterior CR → E[CPL] высок → не выше TV65 (cap режет уплифт)', () => {
    // CR 5%: E[CPL@TV65]=95/0.05=1900<2000 ок; @TV75=104/0.05=2080>2000 нет → остаётся TV65.
    const r = recommendMarginalBid({
      auctionBids: ladder, posteriorCr: 0.05, leadValueRub: 20000, cplCapPct: 0.1, currentBidMicro: 90 * MICRO,
    })
    expect(r.targetTv).toBe(65)
  })

  it('премиум-вето: даже если E[CPL] премиума прошёл бы cap — TV≥85 исключён', () => {
    // Огромный CR → все E[CPL] малы, но премиум всё равно вето.
    const r = recommendMarginalBid({
      auctionBids: ladder, posteriorCr: 0.9, leadValueRub: 20000, cplCapPct: 0.1, currentBidMicro: 100 * MICRO,
    })
    expect(r.targetTv).toBe(80) // максимальный НЕ-премиум
  })

  it('потолок 400 ₽: уровень с Bid > потолка исключён', () => {
    const pricey = [
      { TrafficVolume: 65, Bid: 100 * MICRO, Price: 95 * MICRO },
      { TrafficVolume: 75, Bid: 500 * MICRO, Price: 480 * MICRO }, // Bid 500 > 400 потолок
    ]
    const r = recommendMarginalBid({
      auctionBids: pricey, posteriorCr: 0.5, leadValueRub: 20000, cplCapPct: 0.1, currentBidMicro: 40 * MICRO,
    })
    expect(r.targetTv).toBe(65) // TV75 отсечён потолком; вход TV65 (100 ₽) выше current 40 → change
    expect(r.targetBidMicro).toBeLessThanOrEqual(BID_CEILING_MICRO)
  })
})
