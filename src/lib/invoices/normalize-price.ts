export type NormalizedPrice = {
  /** Цена в единицах ingredient.unit: для KG → ₽/кг, для L → ₽/л, для PCS → ₽/шт. */
  pricePerNormalizedUnit: number
  /** Человекочитаемое описание конвертации. Если '' — конвертации не было. */
  conversionNote: string
}

const G_PER_KG = 1000
const ML_PER_L = 1000

/**
 * Приводит распознанную цену из накладной (rawUnit) к ingredient.unit.
 * Не падает: при неконвертируемых единицах (например, "уп" → KG без веса упаковки)
 * возвращает pricePerNormalizedUnit = 0 и conversionNote с описанием проблемы —
 * caller помечает строку как SKIPPED.
 */
export function normalizePriceToIngredientUnit(input: {
  pricePerUnit: number
  quantity: number
  unit: string
  ingredientUnit: 'KG' | 'L' | 'PCS'
}): NormalizedPrice {
  const u = input.unit.toLowerCase().trim()

  // Граммы → килограммы для KG-ингредиентов
  if (input.ingredientUnit === 'KG') {
    if (u === 'кг' || u === 'kg') {
      return { pricePerNormalizedUnit: input.pricePerUnit, conversionNote: '' }
    }
    if (u === 'г' || u === 'гр' || u === 'g') {
      return {
        pricePerNormalizedUnit: input.pricePerUnit * G_PER_KG,
        conversionNote: 'г → кг (×1000)',
      }
    }
  }

  // Миллилитры → литры для L-ингредиентов
  if (input.ingredientUnit === 'L') {
    if (u === 'л' || u === 'l') {
      return { pricePerNormalizedUnit: input.pricePerUnit, conversionNote: '' }
    }
    if (u === 'мл' || u === 'ml') {
      return {
        pricePerNormalizedUnit: input.pricePerUnit * ML_PER_L,
        conversionNote: 'мл → л (×1000)',
      }
    }
  }

  // Штуки для PCS
  if (input.ingredientUnit === 'PCS') {
    if (u === 'шт' || u === 'pcs' || u === 'pc') {
      return { pricePerNormalizedUnit: input.pricePerUnit, conversionNote: '' }
    }
  }

  // Пакет/коробка — без веса упаковки конвертировать нельзя.
  return {
    pricePerNormalizedUnit: 0,
    conversionNote: `Не удалось сконвертировать ${u} → ${input.ingredientUnit} (требуется вес упаковки)`,
  }
}
