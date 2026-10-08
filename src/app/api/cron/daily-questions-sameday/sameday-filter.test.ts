import { describe, it, expect } from 'vitest'
import { buildCandidatesWhere, SAME_DAY_DYNAMIC_LOCATION } from '@/lib/bot/daily-questions-core'

/**
 * Тестируем семантику where-builder'а напрямую (project-стиль: чистые
 * юнит-тесты без prisma-моков). buildCandidatesWhere(true) — для sameDay cron,
 * buildCandidatesWhere(false) — для обычного daily-questions cron.
 *
 * Чтобы проверить, попадёт ли конкретный клиент в выборку, симулируем то, как
 * Prisma вычисляет relation-фильтры `some` / `none` против списка локаций.
 */

interface FakeLocation {
  sameDayDelivery: boolean
  /** По умолчанию true. */
  isActive?: boolean
  /** Есть активное DYNAMIC-питание на точке. По умолчанию true. */
  hasDynamic?: boolean
}

/**
 * Воспроизводит Prisma-семантику locations: { some } / { none } для where с
 * предикатом SAME_DAY_DYNAMIC_LOCATION (sameDayDelivery + isActive + DYNAMIC).
 */
function clientMatchesLocationsFilter(
  where: ReturnType<typeof buildCandidatesWhere>,
  locations: FakeLocation[]
): boolean {
  const locFilter = where.locations as
    | { some?: typeof SAME_DAY_DYNAMIC_LOCATION; none?: typeof SAME_DAY_DYNAMIC_LOCATION }
    | undefined
  if (!locFilter) return true
  const matches = (l: FakeLocation, f: typeof SAME_DAY_DYNAMIC_LOCATION) =>
    l.sameDayDelivery === f.sameDayDelivery &&
    (l.isActive ?? true) === f.isActive &&
    (f.mealConfigs ? (l.hasDynamic ?? true) : true)

  if (locFilter.some) return locations.some((l) => matches(l, locFilter.some!))
  if (locFilter.none) return !locations.some((l) => matches(l, locFilter.none!))
  return true
}

const samedayWhere = buildCandidatesWhere(true)
const dailyWhere = buildCandidatesWhere(false)

describe('buildCandidatesWhere — базовые инварианты', () => {
  it('обе ветки требуют активного клиента и активного DYNAMIC-конфига на активной точке', () => {
    for (const w of [samedayWhere, dailyWhere]) {
      expect(w.isActive).toBe(true)
      expect(w.mealConfigs).toEqual({
        some: { orderType: 'DYNAMIC', isActive: true, location: { isActive: true } },
      })
    }
  })

  it('sameDay cron использует locations.some, обычный — locations.none (активная same-day точка с DYNAMIC)', () => {
    expect(samedayWhere.locations).toEqual({ some: SAME_DAY_DYNAMIC_LOCATION })
    expect(dailyWhere.locations).toEqual({ none: SAME_DAY_DYNAMIC_LOCATION })
    expect(SAME_DAY_DYNAMIC_LOCATION).toEqual({
      sameDayDelivery: true,
      isActive: true,
      mealConfigs: { some: { orderType: 'DYNAMIC', isActive: true } },
    })
  })
})

describe('деактивированная same-day точка', () => {
  const locations: FakeLocation[] = [
    { sameDayDelivery: false },
    { sameDayDelivery: true, isActive: false },
  ]
  it('клиент НЕ попадает в sameday cron (не спрашиваем в 07:40 о сегодня)', () => {
    expect(clientMatchesLocationsFilter(samedayWhere, locations)).toBe(false)
  })
  it('клиент попадает в обычный cron (спрашиваем о завтра)', () => {
    expect(clientMatchesLocationsFilter(dailyWhere, locations)).toBe(true)
  })
})

describe('same-day точка только с FIXED-питанием', () => {
  const locations: FakeLocation[] = [
    { sameDayDelivery: false },
    { sameDayDelivery: true, hasDynamic: false },
  ]
  it('клиент спрашивается обычным cron, не sameday', () => {
    expect(clientMatchesLocationsFilter(samedayWhere, locations)).toBe(false)
    expect(clientMatchesLocationsFilter(dailyWhere, locations)).toBe(true)
  })
})

describe('Test 1: клиент только с обычной локацией', () => {
  const locations: FakeLocation[] = [{ sameDayDelivery: false }]

  it('НЕ попадает в выборку sameday cron', () => {
    expect(clientMatchesLocationsFilter(samedayWhere, locations)).toBe(false)
  })

  it('попадает в выборку обычного daily-questions cron', () => {
    expect(clientMatchesLocationsFilter(dailyWhere, locations)).toBe(true)
  })
})

describe('Test 2: клиент с sameDay-локацией', () => {
  const locations: FakeLocation[] = [{ sameDayDelivery: true }]

  it('попадает в выборку sameday cron', () => {
    expect(clientMatchesLocationsFilter(samedayWhere, locations)).toBe(true)
  })

  it('НЕ попадает в выборку обычного daily-questions cron', () => {
    expect(clientMatchesLocationsFilter(dailyWhere, locations)).toBe(false)
  })
})

describe('Test 3: клиент со смешанными локациями (хотя бы одна sameDay)', () => {
  const locations: FakeLocation[] = [
    { sameDayDelivery: false },
    { sameDayDelivery: true },
    { sameDayDelivery: false },
  ]

  it('попадает в выборку sameday cron (some сработал)', () => {
    expect(clientMatchesLocationsFilter(samedayWhere, locations)).toBe(true)
  })

  it('НЕ попадает в обычный daily-questions cron (none нарушен)', () => {
    expect(clientMatchesLocationsFilter(dailyWhere, locations)).toBe(false)
  })

  it('две ветки взаимоисключающи — клиент ровно в одной выборке', () => {
    const inSameday = clientMatchesLocationsFilter(samedayWhere, locations)
    const inDaily = clientMatchesLocationsFilter(dailyWhere, locations)
    expect(inSameday).not.toBe(inDaily)
  })
})
