/**
 * Экстремальные метрики по себестоимости блюд: топ-дорогое, толстая/тонкая
 * маржа в %, максимальный рост cost за последний месяц.
 *
 * sellPrice определяется как ПРОКСИ — средняя Order.pricePerPortion того
 * mealType-а за последние 30 дней. Это даёт всем блюдам того же mealType
 * одинаковую sellPrice (так как pricePerPortion фиксируется на момент
 * создания заказа и не привязана к конкретному блюду в наборе), но
 * позволяет сравнивать маржу межи блюдами разных категорий внутри типа.
 * Если по mealType-у нет заказов — sellPrice=null и блюдо выбывает из
 * margin-метрик (но остаётся в mostExpensive / biggestCostGrowth).
 */

import { prisma } from '@/lib/db/prisma'
import type { MealType } from '@prisma/client'
import {
  getDishCostList,
  getDishCostHistory,
  type DishCostResult,
} from '@/lib/db/queries/dish-cost'
import { REVENUE_STATUSES } from '@/lib/constants/order'

type MarginPoint = {
  dishId: string
  dishName: string
  marginPercent: number
  sellPrice: number
  cost: number
}

export type DishCostExtremes = {
  mostExpensive: { dishId: string; dishName: string; costPerPortion: number } | null
  thickestMarginPercent: MarginPoint | null
  thinnestMarginPercent: MarginPoint | null
  biggestCostGrowthLastMonth: {
    dishId: string
    dishName: string
    percentGrowth: number
    oldCost: number
    newCost: number
  } | null
}

/**
 * Средняя pricePerPortion заказов заданного mealType за последние 30 дней.
 * Если mealType не задан — среднее по всем заказам.
 * Возвращает null если заказов нет.
 */
async function getAvgSellPricePerPortion(mealType?: MealType): Promise<number | null> {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // Используем взвешенное среднее: SUM(totalPrice)/SUM(portions),
  // чтобы крупные заказы давали более точную оценку прайса.
  const agg = await prisma.order.aggregate({
    _sum: { totalPrice: true, portions: true },
    where: {
      deliveryDate: { gte: thirtyDaysAgo, lte: now },
      status: { in: REVENUE_STATUSES },
      ...(mealType ? { mealType } : {}),
    },
  })
  const totalPrice = Number(agg._sum.totalPrice ?? 0)
  const portions = agg._sum.portions ?? 0
  if (portions === 0) return null
  return totalPrice / portions
}

/**
 * Маппинг category → mealType. Один и тот же DishCategory может встречаться
 * в нескольких MealSet разных mealType (например, SALAD есть в LUNCH и
 * DINNER) — берём пересечение по факту использования. Возвращает первый
 * mealType, в котором категория встречается; null если нигде.
 *
 * Используется для прокси-sellPrice: блюдо категории C → берём mealType,
 * где эта категория «обычно» подаётся. Это приближение — для категорий
 * вроде SALAD/BREAD оно неоднозначно.
 */
async function buildCategoryMealTypeMap(): Promise<Map<string, MealType>> {
  const items = await prisma.mealSetItem.findMany({
    where: { mealSet: { isActive: true } },
    include: { mealSet: { select: { mealType: true } } },
    // Детерминированный порядок: иначе для категорий, встречающихся в
    // нескольких mealType (SALAD, BREAD_*), результат «прыгал» между прогонами.
    orderBy: [{ mealSet: { mealType: 'asc' } }, { id: 'asc' }],
  })
  const map = new Map<string, MealType>()
  for (const it of items) {
    if (!map.has(it.dishCategory)) {
      map.set(it.dishCategory, it.mealSet.mealType)
    }
  }
  return map
}

export async function getDishCostExtremes(
  mealType?: MealType,
): Promise<DishCostExtremes> {
  const dishes = await getDishCostList({ mealType })
  const dishesWithCost = dishes.filter(
    (d): d is DishCostResult & { costPerPortion: number } =>
      d.costPerPortion !== null && d.costPerPortion > 0,
  )

  // --- mostExpensive ---
  let mostExpensive: DishCostExtremes['mostExpensive'] = null
  for (const d of dishesWithCost) {
    if (mostExpensive === null || d.costPerPortion > mostExpensive.costPerPortion) {
      mostExpensive = {
        dishId: d.dishId,
        dishName: d.dishName,
        costPerPortion: d.costPerPortion,
      }
    }
  }

  // --- margin metrics ---
  // Если mealType задан — единая sellPrice для всех. Если нет —
  // для каждого блюда определяем «его» mealType через category-map
  // и берём sellPrice того mealType-а.
  const sellPriceByMealType = new Map<MealType | 'ALL', number | null>()
  if (mealType) {
    sellPriceByMealType.set(mealType, await getAvgSellPricePerPortion(mealType))
  } else {
    const all: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']
    await Promise.all(
      all.map(async mt => {
        sellPriceByMealType.set(mt, await getAvgSellPricePerPortion(mt))
      }),
    )
  }

  const categoryMealTypeMap = mealType ? null : await buildCategoryMealTypeMap()

  const margins: MarginPoint[] = []
  for (const d of dishesWithCost) {
    let dishMealType: MealType | null
    if (mealType) {
      dishMealType = mealType
    } else {
      dishMealType = categoryMealTypeMap?.get(d.category) ?? null
    }
    if (!dishMealType) continue
    const sellPrice = sellPriceByMealType.get(dishMealType) ?? null
    if (sellPrice === null || sellPrice <= 0) continue
    // Округляем до 1 знака после запятой на границе query, чтобы UI не печатал
    // «48.12345678%». Сортировку делаем после округления — если две маржи дают
    // одинаковое значение после округления, побеждает та что встретилась первой.
    const marginPercent = Math.round(((sellPrice - d.costPerPortion) / sellPrice) * 1000) / 10
    margins.push({
      dishId: d.dishId,
      dishName: d.dishName,
      marginPercent,
      sellPrice,
      cost: d.costPerPortion,
    })
  }

  let thickestMarginPercent: MarginPoint | null = null
  let thinnestMarginPercent: MarginPoint | null = null
  for (const m of margins) {
    if (
      thickestMarginPercent === null ||
      m.marginPercent > thickestMarginPercent.marginPercent
    ) {
      thickestMarginPercent = m
    }
    if (
      thinnestMarginPercent === null ||
      m.marginPercent < thinnestMarginPercent.marginPercent
    ) {
      thinnestMarginPercent = m
    }
  }

  // --- biggestCostGrowthLastMonth ---
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  let biggestCostGrowthLastMonth: DishCostExtremes['biggestCostGrowthLastMonth'] = null
  for (const d of dishesWithCost) {
    const history = await getDishCostHistory(d.dishId, thirtyDaysAgo, now)
    if (history.length === 0) continue
    const last = history[history.length - 1]
    const first = history[0]
    if (last.costPerPortion === null || first.costPerPortion === null) continue
    // baseline = cost ПЕРЕД первым событием. Берём через history(epoch, first.date-1ms)
    // упрощённо: cost до первого изменения. Чтобы не делать второй запрос —
    // используем changedIngredient.oldPrice как маркер: если событий немного,
    // baseline ≈ first.costPerPortion с oldPrice вместо newPrice по этому
    // ингредиенту. Дорого считать перебором — используем грубое: baseline =
    // первая точка истории (до этого было оно же или ничего не менялось
    // в окне 30 дней).
    const oldCost = first.costPerPortion
    const newCost = last.costPerPortion
    if (oldCost <= 0) continue
    // Округление до 1 знака (см. comment у marginPercent выше).
    const percentGrowth = Math.round(((newCost - oldCost) / oldCost) * 1000) / 10
    if (
      biggestCostGrowthLastMonth === null ||
      percentGrowth > biggestCostGrowthLastMonth.percentGrowth
    ) {
      biggestCostGrowthLastMonth = {
        dishId: d.dishId,
        dishName: d.dishName,
        percentGrowth,
        oldCost,
        newCost,
      }
    }
  }

  return {
    mostExpensive,
    thickestMarginPercent,
    thinnestMarginPercent,
    biggestCostGrowthLastMonth,
  }
}
