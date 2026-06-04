import type { MealType } from '@prisma/client'

/**
 * MEGA-4b (П3): резолвер «целевой» точки + типа питания для запроса клиента
 * на изменение/создание заказа.
 *
 * Клиент в MAX пишет «давай 12 порций на завтра», но у него может быть
 * несколько активных meal-config'ов (разные локации / разные типы питания).
 * Чтобы понять, какой именно заказ менять/создавать, нужно однозначно
 * определить (locationId, mealType). Если однозначности нет — возвращаем
 * причину неоднозначности, чтобы caller (process-message, Subagent D)
 * либо переспросил клиента, либо эскалировал менеджеру.
 *
 * parsedMealType приходит уже как enum MealType (BREAKFAST/LUNCH/DINNER) —
 * конверсия РУС→enum делается ДО вызова (Subagent D). Здесь принимаем
 * MealType | null.
 */

export type ResolveTargetResult =
  | { ok: true; locationId: string; mealType: MealType; configCount: number }
  | {
      ok: false
      reason:
        | 'no_active_config'
        | 'ambiguous_meal_type'
        | 'ambiguous_location'
        | 'meal_type_not_active'
    }

export interface ResolveTargetMealConfig {
  id: string
  mealType: MealType
  locationId: string
  isActive: boolean
}

export interface ResolveTargetLocation {
  id: string
  isActive: boolean
}

export function resolveOrderChangeTarget(params: {
  client: {
    mealConfigs: ResolveTargetMealConfig[]
    locations: ResolveTargetLocation[]
  }
  parsedMealType: MealType | null
}): ResolveTargetResult {
  const { client, parsedMealType } = params

  // Множество id активных локаций — config считается активным только если
  // и сам isActive, и его локация активна.
  const activeLocationIds = new Set(
    client.locations.filter((l) => l.isActive).map((l) => l.id),
  )

  const activeConfigs = client.mealConfigs.filter(
    (c) => c.isActive && activeLocationIds.has(c.locationId),
  )

  if (activeConfigs.length === 0) {
    return { ok: false, reason: 'no_active_config' }
  }

  if (activeConfigs.length === 1) {
    const only = activeConfigs[0]
    return {
      ok: true,
      locationId: only.locationId,
      mealType: only.mealType,
      configCount: 1,
    }
  }

  // >1 активный config.
  if (parsedMealType === null) {
    const distinctMealTypes = new Set(activeConfigs.map((c) => c.mealType))
    if (distinctMealTypes.size > 1) {
      // Разные типы питания → не знаем, какой имел в виду клиент.
      return { ok: false, reason: 'ambiguous_meal_type' }
    }
    // Один тип питания, но >1 config → значит разные локации.
    return { ok: false, reason: 'ambiguous_location' }
  }

  // parsedMealType задан → фильтруем по нему.
  const matching = activeConfigs.filter((c) => c.mealType === parsedMealType)
  if (matching.length === 0) {
    return { ok: false, reason: 'meal_type_not_active' }
  }
  if (matching.length === 1) {
    const only = matching[0]
    return {
      ok: true,
      locationId: only.locationId,
      mealType: only.mealType,
      configCount: activeConfigs.length,
    }
  }
  // Один тип питания на нескольких локациях → неоднозначна локация.
  return { ok: false, reason: 'ambiguous_location' }
}
