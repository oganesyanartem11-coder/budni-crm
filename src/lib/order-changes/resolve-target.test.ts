import { describe, it, expect } from 'vitest'
import { resolveOrderChangeTarget } from './resolve-target'
import type {
  ResolveTargetMealConfig,
  ResolveTargetLocation,
} from './resolve-target'

/**
 * Покрываем все ветки резолвера: 0/1/>1 активных config'а, неоднозначность
 * по типу питания vs локации, фильтрация по parsedMealType, исключение
 * неактивных config'ов и локаций.
 */

function cfg(
  partial: Partial<ResolveTargetMealConfig> & { mealType: ResolveTargetMealConfig['mealType']; locationId: string },
): ResolveTargetMealConfig {
  return {
    id: partial.id ?? `cfg_${Math.random().toString(36).slice(2)}`,
    isActive: partial.isActive ?? true,
    mealType: partial.mealType,
    locationId: partial.locationId,
  }
}

function loc(id: string, isActive = true): ResolveTargetLocation {
  return { id, isActive }
}

describe('resolveOrderChangeTarget', () => {
  it('0 активных config → no_active_config', () => {
    const r = resolveOrderChangeTarget({
      client: { mealConfigs: [], locations: [loc('L1')] },
      parsedMealType: null,
    })
    expect(r).toEqual({ ok: false, reason: 'no_active_config' })
  })

  it('1 активный config → ok с этой локацией/типом', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [cfg({ mealType: 'LUNCH', locationId: 'L1' })],
        locations: [loc('L1')],
      },
      parsedMealType: null,
    })
    expect(r).toEqual({ ok: true, locationId: 'L1', mealType: 'LUNCH', configCount: 1 })
  })

  it('>1 config один mealType разные локации + parsedMealType=null → ambiguous_location', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }),
          cfg({ mealType: 'LUNCH', locationId: 'L2' }),
        ],
        locations: [loc('L1'), loc('L2')],
      },
      parsedMealType: null,
    })
    expect(r).toEqual({ ok: false, reason: 'ambiguous_location' })
  })

  it('>1 config разные mealType + parsedMealType=null → ambiguous_meal_type', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }),
          cfg({ mealType: 'DINNER', locationId: 'L1' }),
        ],
        locations: [loc('L1')],
      },
      parsedMealType: null,
    })
    expect(r).toEqual({ ok: false, reason: 'ambiguous_meal_type' })
  })

  it('>1 config + parsedMealType matched ровно 1 → ok', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }),
          cfg({ mealType: 'DINNER', locationId: 'L2' }),
        ],
        locations: [loc('L1'), loc('L2')],
      },
      parsedMealType: 'DINNER',
    })
    expect(r).toEqual({ ok: true, locationId: 'L2', mealType: 'DINNER', configCount: 2 })
  })

  it('parsedMealType отсутствует среди активных → meal_type_not_active', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }),
          cfg({ mealType: 'DINNER', locationId: 'L2' }),
        ],
        locations: [loc('L1'), loc('L2')],
      },
      parsedMealType: 'BREAKFAST',
    })
    expect(r).toEqual({ ok: false, reason: 'meal_type_not_active' })
  })

  it('parsedMealType matched >1 локации → ambiguous_location', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }),
          cfg({ mealType: 'LUNCH', locationId: 'L2' }),
        ],
        locations: [loc('L1'), loc('L2')],
      },
      parsedMealType: 'LUNCH',
    })
    expect(r).toEqual({ ok: false, reason: 'ambiguous_location' })
  })

  it('неактивные config/локации исключаются (остаётся 1 активный → ok)', () => {
    const r = resolveOrderChangeTarget({
      client: {
        mealConfigs: [
          cfg({ mealType: 'LUNCH', locationId: 'L1' }), // активен
          cfg({ mealType: 'DINNER', locationId: 'L1', isActive: false }), // config неактивен
          cfg({ mealType: 'BREAKFAST', locationId: 'L2' }), // локация неактивна
        ],
        locations: [loc('L1'), loc('L2', false)],
      },
      parsedMealType: null,
    })
    expect(r).toEqual({ ok: true, locationId: 'L1', mealType: 'LUNCH', configCount: 1 })
  })
})
