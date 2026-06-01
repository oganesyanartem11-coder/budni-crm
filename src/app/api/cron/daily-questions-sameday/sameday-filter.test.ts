import { describe, it, expect } from 'vitest'
import { buildCandidatesWhere } from '@/lib/bot/daily-questions-core'

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
}

/** Воспроизводит Prisma-семантику locations: { some } / { none } для where. */
function clientMatchesLocationsFilter(
  where: ReturnType<typeof buildCandidatesWhere>,
  locations: FakeLocation[]
): boolean {
  const locFilter = where.locations as
    | { some?: { sameDayDelivery: boolean }; none?: { sameDayDelivery: boolean } }
    | undefined
  if (!locFilter) return true

  if (locFilter.some) {
    return locations.some((l) => l.sameDayDelivery === locFilter.some!.sameDayDelivery)
  }
  if (locFilter.none) {
    return !locations.some((l) => l.sameDayDelivery === locFilter.none!.sameDayDelivery)
  }
  return true
}

const samedayWhere = buildCandidatesWhere(true)
const dailyWhere = buildCandidatesWhere(false)

describe('buildCandidatesWhere — базовые инварианты', () => {
  it('обе ветки требуют активного клиента и активного DYNAMIC-конфига', () => {
    for (const w of [samedayWhere, dailyWhere]) {
      expect(w.isActive).toBe(true)
      expect(w.mealConfigs).toEqual({ some: { orderType: 'DYNAMIC', isActive: true } })
    }
  })

  it('sameDay cron использует locations.some, обычный — locations.none', () => {
    expect(samedayWhere.locations).toEqual({ some: { sameDayDelivery: true } })
    expect(dailyWhere.locations).toEqual({ none: { sameDayDelivery: true } })
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
