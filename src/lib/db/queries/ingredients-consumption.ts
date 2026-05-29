import { prisma } from '@/lib/db/prisma'
import type { OrderStatus } from '@prisma/client'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 3600 * 1000

export interface IngredientConsumptionRow {
  ingredientId: string
  ingredientName: string
  unit: 'KG' | 'L' | 'PCS'
  totalNeeded: number // суммарный расход за период в единицах ингредиента
  pricePerUnit: number // текущая цена (для отображения в UI; в totalCost — историческая per-day)
  totalCost: number // sum по дням: needed-of-day × price-of-day (историческая цена per day)
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
 * Использует историческую цену — для каждого дня цена ингредиента берётся
 * на этот день (priceHistory). Для дат когда истории нет — fallback на
 * текущую pricePerUnit.
 * Учитывает MealSetItem.quantity (Sprint 7.11 O-3): набор может включать
 * несколько штук одной категории (например, 2 хлеба на обед).
 *
 * MSK-нормализация границ обязательна: на UTC-сервере setHours(0,0,0,0)
 * к from/to от getFinancialWeek даёт неверный totalDays и dayOfWeek.
 */
async function buildPriceMapAtDate(
  asOfDate: Date,
  ingredientIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (ingredientIds.length === 0) return map

  const histRows = await prisma.ingredientPriceHistory.findMany({
    where: { ingredientId: { in: ingredientIds }, validFrom: { lte: asOfDate } },
    orderBy: { validFrom: 'desc' },
    select: { ingredientId: true, price: true },
  })
  for (const ph of histRows) {
    if (!map.has(ph.ingredientId)) {
      map.set(ph.ingredientId, Number(ph.price))
    }
  }

  const orphans = ingredientIds.filter((id) => !map.has(id))
  if (orphans.length > 0) {
    const current = await prisma.ingredient.findMany({
      where: { id: { in: orphans } },
      select: { id: true, pricePerUnit: true },
    })
    for (const c of current) {
      map.set(c.id, Number(c.pricePerUnit))
    }
  }
  return map
}

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

    // Собрать ingredientIds для этого дня и построить per-day priceMap
    // на dayStart (историческая цена). Fallback на pricePerUnit внутри
    // buildPriceMapAtDate (legacy seeds без priceHistory).
    const dayIngredientIds = new Set<string>()
    for (const day of menu.days) {
      for (const menuDish of day.dishes) {
        for (const di of menuDish.dish.ingredients) {
          dayIngredientIds.add(di.ingredientId)
        }
      }
    }
    const priceMap = await buildPriceMapAtDate(dayStart, Array.from(dayIngredientIds))

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
          const price = priceMap.get(di.ingredientId) ?? Number(di.ingredient.pricePerUnit)
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
              // pricePerUnit в row — текущая (для отображения «цена ингредиента сейчас»);
              // totalCost — суммированный по дням с per-day исторической ценой.
              pricePerUnit: Number(di.ingredient.pricePerUnit),
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
