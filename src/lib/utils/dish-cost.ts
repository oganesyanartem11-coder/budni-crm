import type { Decimal } from '@prisma/client/runtime/library'

export interface DishIngredientForCost {
  bruttoGrams: number
  ingredient: {
    pricePerUnit: number
    unit: 'KG' | 'L' | 'PCS'
  }
}

/**
 * Считает себестоимость блюда (1 базовая единица) по техкарте и текущим ценам сырья.
 * Возвращает сумму в рублях.
 *
 * Формула:
 * - Для KG/L: bruttoGrams в килограммах * pricePerUnit
 * - Для PCS: bruttoGrams трактуется как количество штук * pricePerUnit
 */
export function calculateDishCost(ingredients: DishIngredientForCost[]): number {
  let total = 0
  for (const line of ingredients) {
    const price = line.ingredient.pricePerUnit
    const qty = line.bruttoGrams

    if (line.ingredient.unit === 'PCS') {
      // bruttoGrams здесь — количество штук
      total += qty * price
    } else {
      // KG / L: bruttoGrams в граммах/мл, переводим в кг/л
      total += (qty / 1000) * price
    }
  }
  return total
}
