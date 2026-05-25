import { prisma } from '@/lib/db/prisma'
import type { OrderStatus } from '@prisma/client'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 3600 * 1000

export interface IngredientConsumptionRow {
  ingredientId: string
  ingredientName: string
  unit: 'KG' | 'L' | 'PCS'
  totalNeeded: number // суммарный расход за период в единицах ингредиента
  pricePerUnit: number // CURRENT цена (как и в material-cost — historical отложен)
  totalCost: number // totalNeeded × pricePerUnit
}

export interface IngredientsConsumptionResult {
  rows: IngredientConsumptionRow[] // отсортированы DESC по totalCost
  totalCost: number
  daysWithoutMenu: number
  totalDays: number
}

/**
 * Агрегирует расход ингредиентов за период [from, to].
 *
 * Логика per-day копирует getIngredientsSummary (production.ts) и
 * getMaterialCostForRange (digest/material-cost.ts):
 * - Поиск APPROVED MenuCycle на день (по MSK-дате).
 * - Загрузка Order на день с фильтром по statuses, группировка portions по mealType.
 * - Для каждого MenuDay → блюда → ингредиенты:
 *     KG/L: needed = (bruttoGrams / 1000) × portions
 *     PCS:  needed = bruttoGrams × portions
 *
 * Использует CURRENT Ingredient.pricePerUnit (historical отложен в тех-долг).
 * Учитывает MealSetItem.quantity (Sprint 7.11 O-3): набор может включать
 * несколько штук одной категории (например, 2 хлеба на обед).
 *
 * MSK-нормализация границ обязательна: на UTC-сервере setHours(0,0,0,0)
 * к from/to от getFinancialWeek даёт неверный totalDays и dayOfWeek.
 */
export async function getIngredientsConsumptionForRange(
  from: Date,
  to: Date,
  statuses: OrderStatus[]
): Promise<IngredientsConsumptionResult> {
  // 1. Нормализация границ к MSK-полуночи (как в material-cost.ts).
  const fromMskShifted = new Date(from.getTime() + MSK_OFFSET_MS)
  const startMs =
    Date.UTC(
      fromMskShifted.getUTCFullYear(),
      fromMskShifted.getUTCMonth(),
      fromMskShifted.getUTCDate(),
      0, 0, 0, 0
    ) - MSK_OFFSET_MS

  const toMskShifted = new Date(to.getTime() + MSK_OFFSET_MS)
  const endMs =
    Date.UTC(
      toMskShifted.getUTCFullYear(),
      toMskShifted.getUTCMonth(),
      toMskShifted.getUTCDate(),
      0, 0, 0, 0
    ) - MSK_OFFSET_MS

  if (endMs < startMs) {
    return { rows: [], totalCost: 0, daysWithoutMenu: 0, totalDays: 0 }
  }

  const totalDays = Math.round((endMs - startMs) / ONE_DAY_MS) + 1

  const acc = new Map<string, IngredientConsumptionRow>()
  let daysWithoutMenu = 0

  for (let i = 0; i < totalDays; i++) {
    const dayStart = new Date(startMs + i * ONE_DAY_MS)
    const dayEnd = new Date(dayStart.getTime() + ONE_DAY_MS - 1)

    // MSK day-of-week (ISO: 1=Пн, 7=Вс).
    const dayMskShifted = new Date(dayStart.getTime() + MSK_OFFSET_MS)
    const jsDay = dayMskShifted.getUTCDay()
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    const menu = await prisma.menuCycle.findFirst({
      where: {
        status: 'APPROVED',
        validFrom: { lte: dayStart },
        validTo: { gte: dayStart },
      },
      include: {
        days: {
          where: { dayOfWeek },
          include: {
            mealSet: { include: { items: true } },
            dishes: {
              include: {
                dish: {
                  include: {
                    ingredients: {
                      include: { ingredient: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!menu) {
      daysWithoutMenu++
      continue
    }

    const orders = await prisma.order.findMany({
      where: {
        deliveryDate: { gte: dayStart, lte: dayEnd },
        status: { in: statuses },
      },
      select: { mealType: true, portions: true },
    })

    if (orders.length === 0) continue

    const portionsByMealType = new Map<string, number>()
    for (const o of orders) {
      portionsByMealType.set(o.mealType, (portionsByMealType.get(o.mealType) ?? 0) + o.portions)
    }

    for (const menuDay of menu.days) {
      const portions = portionsByMealType.get(menuDay.mealType) ?? 0
      if (portions === 0) continue

      // MealSetItem.quantity на slotCategory (Sprint 7.11 O-3).
      const categoryQty = new Map<string, number>()
      if (menuDay.mealSet) {
        for (const item of menuDay.mealSet.items) {
          categoryQty.set(item.dishCategory, item.quantity)
        }
      }

      for (const mdd of menuDay.dishes) {
        const slotQty = categoryQty.get(mdd.slotCategory) ?? 1
        const effectivePortions = portions * slotQty

        for (const di of mdd.dish.ingredients) {
          const brutto = Number(di.bruttoGrams)
          const price = Number(di.ingredient.pricePerUnit)
          const unit = di.ingredient.unit as 'KG' | 'L' | 'PCS'

          const needed = unit === 'PCS' ? brutto * effectivePortions : (brutto / 1000) * effectivePortions
          const cost = needed * price

          const existing = acc.get(di.ingredientId)
          if (existing) {
            existing.totalNeeded += needed
            existing.totalCost += cost
          } else {
            acc.set(di.ingredientId, {
              ingredientId: di.ingredientId,
              ingredientName: di.ingredient.name,
              unit,
              totalNeeded: needed,
              pricePerUnit: price,
              totalCost: cost,
            })
          }
        }
      }
    }
  }

  const rows = Array.from(acc.values()).sort((a, b) => b.totalCost - a.totalCost)
  const totalCost = rows.reduce((sum, r) => sum + r.totalCost, 0)

  return { rows, totalCost, daysWithoutMenu, totalDays }
}
