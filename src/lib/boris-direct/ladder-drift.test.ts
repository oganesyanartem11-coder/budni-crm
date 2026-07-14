import { describe, it, expect } from 'vitest'
import { summarizeLadderEntry, detectLadderDrift, summarizePositionTrend } from './ladder-drift'
import type { KeywordBidRecord } from './direct-client'
import { MICRO } from './config'

/** Хелпер: запись лесенки с заданными (TV, Bid ₽) позициями и текущей ставкой. */
function rec(keywordId: number, bidRub: number, ladder: Array<[number, number]>): KeywordBidRecord {
  return {
    KeywordId: keywordId,
    AdGroupId: 1,
    CampaignId: 1,
    Search: {
      Bid: bidRub * MICRO,
      AuctionBids: ladder.map(([tv, r]) => ({ TrafficVolume: tv, Bid: r * MICRO, Price: r * MICRO })),
    },
  }
}

describe('summarizeLadderEntry', () => {
  it('медиана цены входа (TV≥55) и доля ниже входа', () => {
    const bids = [
      // ставка 100, вход TV55 стоит 90 → ВЫШЕ входа
      rec(1, 100, [[15, 50], [55, 90], [75, 140]]),
      // ставка 80, вход TV55 стоит 130 → НИЖЕ входа
      rec(2, 80, [[15, 60], [55, 130], [75, 180]]),
      // ставка 150, вход TV55 стоит 110 → выше входа
      rec(3, 150, [[55, 110], [75, 160]]),
    ]
    const s = summarizeLadderEntry(bids)
    expect(s.phrases).toBe(3)
    // цены входа: 90,130,110 → медиана 110
    expect(s.entryMedianRub).toBe(110)
    // ниже входа: только #2 → 33%
    expect(s.belowEntryPct).toBeCloseTo(33.33, 1)
  })

  it('фразы без лесенки/без входа TV≥55 не учитываются', () => {
    const bids = [
      rec(1, 100, []), // нет лесенки
      rec(2, 100, [[15, 50], [45, 70]]), // нет позиции TV≥55
      rec(3, 100, [[55, 90]]), // валидна
    ]
    const s = summarizeLadderEntry(bids)
    expect(s.phrases).toBe(1)
    expect(s.entryMedianRub).toBe(90)
  })

  it('пустой ввод → нули/null', () => {
    const s = summarizeLadderEntry([])
    expect(s.phrases).toBe(0)
    expect(s.entryMedianRub).toBeNull()
    expect(s.belowEntryPct).toBeNull()
  })
})

describe('detectLadderDrift', () => {
  it('РЕТРО-ОЖИДАНИЕ: стабильный вход (дрейф ≈0) → тишина', () => {
    const out = detectLadderDrift({
      today: { entryMedianRub: 95, belowEntryPct: 28, phrases: 194 },
      past: { entryMedianRub: 95, belowEntryPct: 28, phrases: 190 },
    })
    expect(out.alert).toBeNull()
    expect(Math.abs(out.medianDeltaPct)).toBeLessThan(0.01)
  })

  it('скачок медианы входа > 20% → WARN', () => {
    const out = detectLadderDrift({
      today: { entryMedianRub: 130, belowEntryPct: 28, phrases: 194 },
      past: { entryMedianRub: 95, belowEntryPct: 28, phrases: 190 },
    })
    // (130−95)/95 ≈ +36.8%
    expect(out.alert).not.toBeNull()
    expect(out.alert!.severity).toBe('warn')
    expect(out.alert!.kind).toBe('ladder_drift')
    expect(out.alert!.text).toMatch(/вход|ставк|аукцион/i)
  })

  it('рост доли ниже входа на ≥10 п.п. → WARN', () => {
    const out = detectLadderDrift({
      today: { entryMedianRub: 96, belowEntryPct: 45, phrases: 194 },
      past: { entryMedianRub: 95, belowEntryPct: 28, phrases: 190 },
    })
    // медиана почти не двинулась (+1%), но below-entry +17 п.п.
    expect(out.alert).not.toBeNull()
    expect(out.belowEntryDeltaPp).toBeCloseTo(17, 5)
  })

  it('нет прошлой базы → тишина (нечего сравнивать)', () => {
    const out = detectLadderDrift({
      today: { entryMedianRub: 130, belowEntryPct: 50, phrases: 194 },
      past: { entryMedianRub: null, belowEntryPct: null, phrases: 0 },
    })
    expect(out.alert).toBeNull()
  })

  it('снижение доли ниже входа (улучшение) не тревожит', () => {
    const out = detectLadderDrift({
      today: { entryMedianRub: 95, belowEntryPct: 10, phrases: 194 },
      past: { entryMedianRub: 95, belowEntryPct: 28, phrases: 190 },
    })
    expect(out.alert).toBeNull()
  })
})

describe('summarizePositionTrend', () => {
  it('клико-взвешенная позиция/TV по дням + вердикт стабильности (аудит: ≈flat)', () => {
    // Реальный ряд взвешенной позиции клика 09–13.07 (форензика): 2.64, 4.17,
    // 3.8, 2.71, 3.63 — колеблется в 2.6–4.2, тренда нет (early≈late).
    const rows = [
      { day: '2026-07-09', clicks: 14, avgClickPosition: 2.64, avgTrafficVolume: 65.7 },
      { day: '2026-07-10', clicks: 7, avgClickPosition: 4.17, avgTrafficVolume: 62.5 },
      { day: '2026-07-11', clicks: 5, avgClickPosition: 3.8, avgTrafficVolume: 80.6 },
      { day: '2026-07-12', clicks: 8, avgClickPosition: 2.71, avgTrafficVolume: 64.9 },
      { day: '2026-07-13', clicks: 9, avgClickPosition: 3.63, avgTrafficVolume: 73.7 },
    ]
    const out = summarizePositionTrend(rows)
    expect(out.days).toHaveLength(5)
    expect(out.days[0].weightedPosition).toBeCloseTo(2.64, 2)
    expect(out.trend).toBe('flat')
  })

  it('позиция клика РАСТЁТ (хуже) к концу окна → worsening', () => {
    const rows = [
      { day: '2026-07-01', clicks: 10, avgClickPosition: 2.0, avgTrafficVolume: 70 },
      { day: '2026-07-02', clicks: 10, avgClickPosition: 2.2, avgTrafficVolume: 68 },
      { day: '2026-07-08', clicks: 10, avgClickPosition: 5.5, avgTrafficVolume: 40 },
      { day: '2026-07-09', clicks: 10, avgClickPosition: 6.0, avgTrafficVolume: 35 },
    ]
    expect(summarizePositionTrend(rows).trend).toBe('worsening')
  })

  it('несколько ключей в одном дне усредняются по кликам', () => {
    const rows = [
      { day: '2026-07-09', clicks: 10, avgClickPosition: 2, avgTrafficVolume: 80 },
      { day: '2026-07-09', clicks: 30, avgClickPosition: 4, avgTrafficVolume: 40 },
    ]
    const out = summarizePositionTrend(rows)
    // (2*10 + 4*30)/40 = 3.5
    expect(out.days[0].weightedPosition).toBeCloseTo(3.5, 5)
    expect(out.days[0].clicks).toBe(40)
  })

  it('мало данных → insufficient', () => {
    expect(summarizePositionTrend([{ day: '2026-07-09', clicks: 5, avgClickPosition: 3, avgTrafficVolume: 60 }]).trend).toBe(
      'insufficient'
    )
    expect(summarizePositionTrend([]).trend).toBe('insufficient')
  })
})
