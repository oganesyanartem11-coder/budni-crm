import { describe, it, expect } from 'vitest'
import {
  histConversionRate,
  detectFunnelDeath,
  detectDirectDrought,
} from './funnel'
import { FUNNEL_DEATH_P0, DIRECT_DROUGHT_P0 } from './config'

describe('histConversionRate', () => {
  it('делит сумму целей на сумму визитов по окну', () => {
    const cr = histConversionRate([
      { visits: 50, goalReaches: 4 },
      { visits: 50, goalReaches: 4 },
    ])
    expect(cr).toBeCloseTo(0.08, 5)
  })

  it('null при недоборе визитов в окне (база ненадёжна)', () => {
    expect(histConversionRate([{ visits: 10, goalReaches: 1 }])).toBeNull()
  })

  it('null при нулевой исторической конверсии (не о чем судить)', () => {
    expect(histConversionRate([{ visits: 200, goalReaches: 0 }])).toBeNull()
  })
})

describe('detectFunnelDeath', () => {
  // База: 113 визитов, 9 целей → CR ≈ 7.96% (реальные цифры 01–08.07).
  const histWindow = [{ visits: 113, goalReaches: 9 }]

  it('РЕПЛЕЙ ОКНА 09–13.07: тревога поднимается не позже 11.07', () => {
    // Живые визиты (все источники) по дням окна, цель = 0 (форензика Метрики):
    // 09.07=25, 10.07=11, 11.07=7 → к 11.07 Σ=43. P0=(1−0.0796)^43 ≈ 0.03 < 5%.
    const series = [
      { day: '2026-07-09', visits: 25, goalReaches: 0 },
      { day: '2026-07-10', visits: 11, goalReaches: 0 },
      { day: '2026-07-11', visits: 7, goalReaches: 0 },
    ]
    const out = detectFunnelDeath({ series, histWindow })
    expect(out).not.toBeNull()
    expect(out!.severity).toBe('critical')
    expect(out!.text).toMatch(/визит/i)
    expect(out!.text).toMatch(/форм|воронк|цел/i)
  })

  it('молчит на первом нулевом дне (серия ещё короткая, P0 велик)', () => {
    const series = [{ day: '2026-07-09', visits: 15, goalReaches: 0 }]
    // P0 = (1−0.0796)^15 ≈ 0.29 > 5% → рано.
    expect(detectFunnelDeath({ series, histWindow })).toBeNull()
  })

  it('серия ОБРЫВАЕТСЯ достижением цели — счёт визитов сбрасывается', () => {
    const series = [
      { day: '2026-07-09', visits: 25, goalReaches: 0 },
      { day: '2026-07-10', visits: 25, goalReaches: 1 }, // цель есть → сброс
      { day: '2026-07-11', visits: 7, goalReaches: 0 }, // новая серия с 7 визитов
    ]
    // Хвостовая серия = 7 визитов, P0 велик → молчим.
    expect(detectFunnelDeath({ series, histWindow })).toBeNull()
  })

  it('день с малым числом визитов НЕ входит в серию (шум), но и не обрывает её', () => {
    const series = [
      { day: '2026-07-09', visits: 25, goalReaches: 0 },
      { day: '2026-07-10', visits: 2, goalReaches: 0 }, // < FUNNEL_MIN_VISITS_DAY → игнор
      { day: '2026-07-11', visits: 20, goalReaches: 0 },
    ]
    // Серия = 25 + 20 = 45 визитов (день с 2 визитами пропущен, но серию не рвёт).
    const out = detectFunnelDeath({ series, histWindow })
    expect(out).not.toBeNull()
  })

  it('молчит, когда база CR ненадёжна (мало визитов в истории)', () => {
    const series = [
      { day: '2026-07-09', visits: 25, goalReaches: 0 },
      { day: '2026-07-10', visits: 25, goalReaches: 0 },
    ]
    expect(detectFunnelDeath({ series, histWindow: [{ visits: 10, goalReaches: 1 }] })).toBeNull()
  })

  it('P0 в тексте согласуется с порогом', () => {
    const series = [
      { day: '2026-07-09', visits: 25, goalReaches: 0 },
      { day: '2026-07-10', visits: 25, goalReaches: 0 },
    ]
    const out = detectFunnelDeath({ series, histWindow })
    expect(out).not.toBeNull()
    // 50 визитов, CR 7.96% → P0 ≈ 0.016 < FUNNEL_DEATH_P0.
    expect(FUNNEL_DEATH_P0).toBe(0.05)
  })
})

describe('detectDirectDrought', () => {
  // CR30 Директа ≈ 12.3% (7 заявок / 57 кликов до 08.07).
  const campaignCr = 0.123

  it('клики есть, Директ-конверсий 0 подряд → WARN по P0', () => {
    // 09–13.07 клики Директа: 14,7,5,8,9 → Σ=43, 0 конверсий. P0=(1−0.123)^43 ≈ 0.0036.
    const series = [
      { day: '2026-07-09', clicks: 14, conversions: 0 },
      { day: '2026-07-10', clicks: 7, conversions: 0 },
      { day: '2026-07-11', clicks: 5, conversions: 0 },
      { day: '2026-07-12', clicks: 8, conversions: 0 },
      { day: '2026-07-13', clicks: 9, conversions: 0 },
    ]
    const out = detectDirectDrought({ series, campaignCr })
    expect(out).not.toBeNull()
    expect(out!.severity).toBe('warn')
    expect(out!.text).toMatch(/клик/i)
    expect(DIRECT_DROUGHT_P0).toBe(0.05)
  })

  it('конверсия в серии обрывает счёт кликов', () => {
    const series = [
      { day: '2026-07-09', clicks: 14, conversions: 0 },
      { day: '2026-07-10', clicks: 7, conversions: 1 }, // конверсия → сброс
      { day: '2026-07-11', clicks: 5, conversions: 0 },
    ]
    // Хвост = 5 кликов, P0 велик → молчим.
    expect(detectDirectDrought({ series, campaignCr })).toBeNull()
  })

  it('малый CR-фолбэк не даёт делить на ноль/абсурд (CR≤0 → дефолт)', () => {
    const series = [
      { day: '2026-07-09', clicks: 40, conversions: 0 },
      { day: '2026-07-10', clicks: 40, conversions: 0 },
    ]
    // campaignCr 0 → используется дефолтный prior, всё равно даёт число, не падает.
    const out = detectDirectDrought({ series, campaignCr: 0 })
    expect(out).not.toBeNull()
  })
})
