/**
 * М5 ШАГ 1: прогноз-самокалибровка (клики и расход, НЕ заявки).
 *
 * Тесты ЧИСТЫХ функций прогноза: расчёт по похожим дням недели (рабочий/выходной),
 * «зреет» на малой истории, детектор слома с ДВУМЯ порогами (сигма И абсолют),
 * форматирование строки/гипотез. Оркестрация (runForecastCycle) — вне unit-теста
 * (I/O prisma+telegram, fail-safe в коде); здесь только детерминированная логика.
 */

import { describe, it, expect } from 'vitest'
import {
  forecastNextDay,
  detectForecastBreak,
  formatForecastVsActual,
  formatForecastMaturing,
  formatBreakHypotheses,
  renderForecastLine,
  type DayObservation,
} from './forecast'

const CFG = { minDays: 5 }
const BREAK_CFG = { breakSigma: 3, minClicksDev: 10, minSpendDevRub: 300 }

/** Похожие дни: N рабочих со стабильными кликами/расходом + шумовые выходные. */
function history(): DayObservation[] {
  return [
    { date: '2026-07-01', isWorkday: true, clicks: 60, spendRub: 5000 },
    { date: '2026-07-02', isWorkday: true, clicks: 64, spendRub: 5400 },
    { date: '2026-07-03', isWorkday: true, clicks: 58, spendRub: 4800 },
    { date: '2026-07-06', isWorkday: true, clicks: 62, spendRub: 5200 },
    { date: '2026-07-07', isWorkday: true, clicks: 56, spendRub: 4600 },
    // выходные — другой класс дня, не должны влиять на прогноз рабочего дня.
    { date: '2026-07-04', isWorkday: false, clicks: 5, spendRub: 300 },
    { date: '2026-07-05', isWorkday: false, clicks: 3, spendRub: 200 },
  ]
}

describe('forecastNextDay: среднее по похожим дням + дисперсия', () => {
  it('усредняет ТОЛЬКО дни того же типа (рабочий), выходные игнорирует', () => {
    const f = forecastNextDay(history(), true, CFG)
    expect(f.maturing).toBe(false)
    if (f.maturing) return
    // mean кликов 5 рабочих дней = (60+64+58+62+56)/5 = 60
    expect(Math.round(f.clicks.mean)).toBe(60)
    // mean расхода = (5000+5400+4800+5200+4600)/5 = 5000
    expect(Math.round(f.spend.mean)).toBe(5000)
    expect(f.clicks.n).toBe(5)
    expect(f.clicks.std).toBeGreaterThan(0)
    expect(f.targetIsWorkday).toBe(true)
  })

  it('для выходного берёт выходные дни', () => {
    const f = forecastNextDay(history(), false, { minDays: 2 })
    expect(f.maturing).toBe(false)
    if (f.maturing) return
    expect(f.clicks.n).toBe(2)
    expect(Math.round(f.clicks.mean)).toBe(4) // (5+3)/2
  })

  it('меньше minDays похожих дней → «зреет» с have/need', () => {
    const f = forecastNextDay(history(), false, CFG) // выходных всего 2 < 5
    expect(f.maturing).toBe(true)
    if (!f.maturing) return
    expect(f.have).toBe(2)
    expect(f.need).toBe(5)
    expect(f.targetIsWorkday).toBe(false)
  })

  it('пустая история → зреет, have=0', () => {
    const f = forecastNextDay([], true, CFG)
    expect(f.maturing).toBe(true)
    if (!f.maturing) return
    expect(f.have).toBe(0)
  })
})

describe('detectForecastBreak: ДВА порога (сигма И абсолют)', () => {
  it('факт внутри нормы → слома нет', () => {
    const f = forecastNextDay(history(), true, CFG)
    const breaks = detectForecastBreak(f, { clicks: 61, spendRub: 5100 }, BREAK_CFG)
    expect(breaks).toEqual([])
  })

  it('обвал кликов за 3σ И выше абсолюта → слом (direction below)', () => {
    const f = forecastNextDay(history(), true, CFG)
    // клики 60±~2.8; факт 10 → отклонение 50 ≫ 3σ И ≫ 10 кликов.
    const breaks = detectForecastBreak(f, { clicks: 10, spendRub: 5000 }, BREAK_CFG)
    const clicksBreak = breaks.find((b) => b.dimension === 'clicks')
    expect(clicksBreak).toBeDefined()
    expect(clicksBreak?.direction).toBe('below')
    expect(breaks.find((b) => b.dimension === 'spend')).toBeUndefined()
  })

  it('за 3σ, но НИЖЕ абсолютного порога → НЕ слом (не алертим на мелочь)', () => {
    // История с крошечной дисперсией: 3σ по кликам ~мелочь, но abs-порог 10 спасает.
    const tiny: DayObservation[] = [
      { date: '2026-07-01', isWorkday: true, clicks: 5, spendRub: 400 },
      { date: '2026-07-02', isWorkday: true, clicks: 5, spendRub: 400 },
      { date: '2026-07-03', isWorkday: true, clicks: 6, spendRub: 410 },
      { date: '2026-07-06', isWorkday: true, clicks: 5, spendRub: 400 },
      { date: '2026-07-07', isWorkday: true, clicks: 4, spendRub: 390 },
    ]
    const f = forecastNextDay(tiny, true, CFG)
    // факт 8 кликов: отклонение ~3 от среднего 5 — многовато сигм, но <10 абсолюта.
    const breaks = detectForecastBreak(f, { clicks: 8, spendRub: 405 }, BREAK_CFG)
    expect(breaks).toEqual([])
  })

  it('нулевая дисперсия + отклонение выше абсолюта → слом (sigma=Inf, но abs решает)', () => {
    const flat: DayObservation[] = [
      { date: '2026-07-01', isWorkday: true, clicks: 50, spendRub: 4000 },
      { date: '2026-07-02', isWorkday: true, clicks: 50, spendRub: 4000 },
      { date: '2026-07-03', isWorkday: true, clicks: 50, spendRub: 4000 },
      { date: '2026-07-06', isWorkday: true, clicks: 50, spendRub: 4000 },
      { date: '2026-07-07', isWorkday: true, clicks: 50, spendRub: 4000 },
    ]
    const f = forecastNextDay(flat, true, CFG)
    const breaks = detectForecastBreak(f, { clicks: 90, spendRub: 4050 }, BREAK_CFG)
    // клики +40 (>10 abs) при std=0 → слом; расход +50 (<300 abs) → не слом.
    expect(breaks.map((b) => b.dimension)).toEqual(['clicks'])
    expect(breaks[0].direction).toBe('above')
  })

  it('прогноз «зреет» → детектор молчит', () => {
    const f = forecastNextDay(history(), false, CFG) // maturing
    expect(detectForecastBreak(f, { clicks: 999, spendRub: 99999 }, BREAK_CFG)).toEqual([])
  })

  it('слом по расходу отдельно от кликов', () => {
    const f = forecastNextDay(history(), true, CFG)
    // клики в норме (60), расход обвал 500 (≫3σ И ≫300 ₽).
    const breaks = detectForecastBreak(f, { clicks: 60, spendRub: 500 }, BREAK_CFG)
    expect(breaks.map((b) => b.dimension)).toEqual(['spend'])
    expect(breaks[0].direction).toBe('below')
  })
})

describe('форматирование прогноза', () => {
  it('строка «ждал X±σ, факт Z» по обоим измерениям', () => {
    const f = forecastNextDay(history(), true, CFG)
    if (f.maturing) throw new Error('не должен зреть')
    const line = formatForecastVsActual(f, { clicks: 58, spendRub: 4900 })
    expect(line).toContain('клики')
    expect(line).toContain('факт 58')
    expect(line).toContain('расход')
    expect(line).toContain('факт 4900')
    expect(line).toContain('±')
  })

  it('строка «зреет» с числами', () => {
    const f = forecastNextDay(history(), false, CFG)
    if (!f.maturing) throw new Error('должен зреть')
    const line = formatForecastMaturing(f)
    expect(line).toContain('зреет')
    expect(line).toContain('5') // need
    expect(line).toContain('2') // have
  })

  it('гипотезы направлений: обвал кликов И расхода → аукцион/разметка/сезон', () => {
    const hyp = formatBreakHypotheses([
      { dimension: 'clicks', forecast: 60, actual: 10, sigma: 18, direction: 'below' },
      { dimension: 'spend', forecast: 5000, actual: 800, sigma: 12, direction: 'below' },
    ])
    expect(hyp).toMatch(/аукцион|разметк|сезон/i)
  })

  it('рост расхода при падении кликов → дороже клик (аукцион перегрет)', () => {
    const hyp = formatBreakHypotheses([
      { dimension: 'clicks', forecast: 60, actual: 30, sigma: 6, direction: 'below' },
      { dimension: 'spend', forecast: 5000, actual: 7000, sigma: 5, direction: 'above' },
    ])
    expect(hyp.length).toBeGreaterThan(0)
  })
})

describe('renderForecastLine: интеграция для дневного отчёта', () => {
  it('нет прогноза → null (строку не печатаем)', () => {
    expect(renderForecastLine(null, { clicks: 50, spendRub: 4000 })).toBeNull()
  })

  it('созревший прогноз → строка сверки', () => {
    const f = forecastNextDay(history(), true, CFG)
    const line = renderForecastLine(f, { clicks: 58, spendRub: 4900 })
    expect(line).toContain('факт 58')
  })

  it('зреющий прогноз → строка «зреет»', () => {
    const f = forecastNextDay(history(), false, CFG)
    const line = renderForecastLine(f, { clicks: 5, spendRub: 300 })
    expect(line).toContain('зреет')
  })
})
