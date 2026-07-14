import { describe, it, expect, vi } from 'vitest'
import {
  isWhitelistedCheck,
  CHECK_KEYS,
  evaluateMetrikaGoalSeries,
  evaluateCompareQueryWindows,
  evaluateLadderMedians,
  evaluateCohortEconomics,
  evaluateDeviceGeoSlice,
  executeCheck,
  type CheckDeps,
} from './analyst-checks'

describe('белый список: реестр ключей', () => {
  it('только известные ключи в списке', () => {
    expect(CHECK_KEYS).toContain('metrika_goal_series')
    expect(CHECK_KEYS).toContain('compare_query_windows')
    expect(CHECK_KEYS).toContain('ladder_medians')
    expect(CHECK_KEYS).toContain('cohort_economics')
    expect(CHECK_KEYS).toContain('device_geo_slice')
  })
  it('isWhitelistedCheck: чужой ключ отвергнут', () => {
    expect(isWhitelistedCheck('metrika_goal_series')).toBe(true)
    expect(isWhitelistedCheck('suspend_campaign')).toBe(false)
    expect(isWhitelistedCheck('keywordbids.set')).toBe(false)
  })
})

describe('evaluateMetrikaGoalSeries', () => {
  it('CONFIRMED: живые визиты, хвостовая серия нулей целей после дней с целями', () => {
    const series = [
      { day: '2026-07-06', visits: 20, goalReaches: 2 },
      { day: '2026-07-07', visits: 18, goalReaches: 1 },
      { day: '2026-07-08', visits: 15, goalReaches: 0 },
      { day: '2026-07-09', visits: 16, goalReaches: 0 },
      { day: '2026-07-10', visits: 14, goalReaches: 0 },
    ]
    const out = evaluateMetrikaGoalSeries(series, {})
    expect(out.status).toBe('confirmed')
    expect(out.result).toMatch(/0/)
    expect(out.effectRub).toBeGreaterThan(0) // упущенные заявки × ценность
  })

  it('REFUTED: в хвосте есть достижения цели', () => {
    const series = [
      { day: '2026-07-08', visits: 15, goalReaches: 0 },
      { day: '2026-07-09', visits: 16, goalReaches: 1 },
    ]
    expect(evaluateMetrikaGoalSeries(series, {}).status).toBe('refuted')
  })

  it('INCONCLUSIVE: визитов в хвосте слишком мало (шум)', () => {
    const series = [
      { day: '2026-07-08', visits: 20, goalReaches: 1 },
      { day: '2026-07-09', visits: 2, goalReaches: 0 },
    ]
    expect(evaluateMetrikaGoalSeries(series, {}).status).toBe('inconclusive')
  })
})

describe('evaluateCompareQueryWindows', () => {
  const recent = { clicks: 40, costRub: 6000, conversions: 0 }
  const prior = { clicks: 45, costRub: 5000, conversions: 6 }
  it('CONFIRMED: конверсии обвалились между окнами', () => {
    const out = evaluateCompareQueryWindows(recent, prior, { metric: 'conversions' })
    expect(out.status).toBe('confirmed')
    expect(out.result).toMatch(/6/)
  })
  it('REFUTED: метрика почти не сдвинулась', () => {
    const out = evaluateCompareQueryWindows({ clicks: 44, costRub: 5000, conversions: 6 }, prior, { metric: 'clicks' })
    expect(out.status).toBe('refuted')
  })
  it('INCONCLUSIVE: прошлое окно пустое', () => {
    const out = evaluateCompareQueryWindows(recent, { clicks: 0, costRub: 0, conversions: 0 }, { metric: 'clicks' })
    expect(out.status).toBe('inconclusive')
  })
})

describe('evaluateLadderMedians', () => {
  it('CONFIRMED: медиана входа уехала за окно > порога', () => {
    const perDay = [
      { day: '2026-07-08', entryMedianRub: 95, belowEntryPct: 10 },
      { day: '2026-07-13', entryMedianRub: 130, belowEntryPct: 12 },
    ]
    expect(evaluateLadderMedians(perDay, {}).status).toBe('confirmed')
  })
  it('REFUTED: вход стабилен (страх «протухли» не подтверждён)', () => {
    const perDay = [
      { day: '2026-07-08', entryMedianRub: 95, belowEntryPct: 10 },
      { day: '2026-07-13', entryMedianRub: 97, belowEntryPct: 11 },
    ]
    expect(evaluateLadderMedians(perDay, {}).status).toBe('refuted')
  })
})

describe('evaluateCohortEconomics', () => {
  it('CONFIRMED worse: цена заявки когорты выросла ≥ порога', () => {
    const out = evaluateCohortEconomics(
      { clicksBefore: 60, convBefore: 6, costBefore: 6000, clicksAfter: 60, convAfter: 3, costAfter: 6000 },
      {}
    )
    expect(out.status).toBe('confirmed')
    expect(out.result).toMatch(/выросла|хуже|дороже/i)
  })
  it('INCONCLUSIVE: кликов меньше минимума честности', () => {
    const out = evaluateCohortEconomics(
      { clicksBefore: 5, convBefore: 0, costBefore: 100, clicksAfter: 5, convAfter: 0, costAfter: 100 },
      {}
    )
    expect(out.status).toBe('inconclusive')
  })
})

describe('evaluateDeviceGeoSlice', () => {
  it('CONFIRMED: сегмент с объёмом и нулём заявок (утечка)', () => {
    const out = evaluateDeviceGeoSlice(
      [
        { segment: 'mobile', visits: 40, conv: 0 },
        { segment: 'desktop', visits: 30, conv: 3 },
      ],
      {}
    )
    expect(out.status).toBe('confirmed')
    expect(out.result).toMatch(/mobile/)
  })
  it('REFUTED: все сегменты конвертят', () => {
    const out = evaluateDeviceGeoSlice([{ segment: 'desktop', visits: 30, conv: 3 }], {})
    expect(out.status).toBe('refuted')
  })
})

describe('executeCheck (диспетчер)', () => {
  const deps: CheckDeps = {
    loadMetrikaGoalSeries: vi.fn(async () => [
      { day: '2026-07-06', visits: 20, goalReaches: 2 },
      { day: '2026-07-09', visits: 16, goalReaches: 0 },
      { day: '2026-07-10', visits: 14, goalReaches: 0 },
    ]),
    loadQueryWindowAgg: vi.fn(async () => ({ clicks: 0, costRub: 0, conversions: 0 })),
    loadLadderPerDay: vi.fn(async () => []),
    loadCohortRows: vi.fn(async () => ({ clicksBefore: 0, convBefore: 0, costBefore: 0, clicksAfter: 0, convAfter: 0, costAfter: 0 })),
    loadDeviceGeoSlice: vi.fn(async () => []),
  }

  it('известный ключ исполняется через deps', async () => {
    const out = await executeCheck({ key: 'metrika_goal_series', params: { windowDays: 14 } }, deps, new Date('2026-07-11T07:00:00Z'))
    expect(out.status).toBe('confirmed')
    expect(deps.loadMetrikaGoalSeries).toHaveBeenCalled()
  })

  it('ключ ВНЕ белого списка → inconclusive, НИ ОДНОЙ deps-функции не зовёт', async () => {
    const spyDeps: CheckDeps = { ...deps, loadMetrikaGoalSeries: vi.fn(async () => []) }
    const out = await executeCheck({ key: 'suspend_campaign', params: {} }, spyDeps, new Date())
    expect(out.status).toBe('inconclusive')
    expect(out.result).toMatch(/вне белого списка|неизвест/i)
    expect(spyDeps.loadMetrikaGoalSeries).not.toHaveBeenCalled()
  })
})
