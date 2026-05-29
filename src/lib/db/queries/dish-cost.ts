/**
 * Server-side queries для себестоимости блюд.
 *
 * Эталонная формула — material-cost.ts (НЕ ломать!). Здесь — обёртки и
 * аналитика per-dish для отчётов и UI. Decimal → number через Number()
 * на границе, наружу отдаём plain JSON-сериализуемые типы (RSC / actions).
 *
 * ВАЖНО: Dish ↔ MealSet связаны только через DishCategory.MealSetItem
 * не содержит dishId — поэтому фильтр «блюда такого-то mealType»
 * означает «блюда категорий, которые встречаются в MealSet с этим mealType».
 */

import { prisma } from '@/lib/db/prisma'
import type {
  DishCategory,
  MealType,
  DishUnit,
  IngredientUnit,
  OrderStatus,
  Prisma,
} from '@prisma/client'

/**
 * Резолвер цены ингредиента на конкретный момент времени.
 * Возвращает цену за единицу (как в Ingredient.pricePerUnit).
 * Используется computeDishCost для расчёта по историческим ценам.
 */
export type PriceResolver = (ingredientId: string) => number

/**
 * Построить PriceResolver для конкретной даты.
 * Один пакетный запрос priceHistory + один pacted fallback на pricePerUnit
 * для «осиротевших» ингредиентов (для которых нет записи validFrom <= asOfDate).
 *
 * Инвариант: для asOfDate=now() результат идентичен Number(ingredient.pricePerUnit).
 */
export async function buildPriceResolverForDate(
  asOfDate: Date,
  ingredientIds: string[]
): Promise<PriceResolver> {
  const map = new Map<string, number>()
  if (ingredientIds.length === 0) {
    return () => 0
  }

  const histRows = await prisma.ingredientPriceHistory.findMany({
    where: {
      ingredientId: { in: ingredientIds },
      validFrom: { lte: asOfDate },
    },
    orderBy: { validFrom: 'desc' },
    select: { ingredientId: true, price: true },
  })
  for (const ph of histRows) {
    if (!map.has(ph.ingredientId)) {
      map.set(ph.ingredientId, Number(ph.price))
    }
  }

  // Fallback для ингредиентов БЕЗ истории <= asOfDate (legacy seeds, новые).
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

  return (id: string) => map.get(id) ?? 0
}

// Статусы заказов, попадающих в production. Дублируем константу из
// queries/production.ts (там она private). Согласовано с эталоном:
// REVENUE_STATUSES + LOCKED − DELIVERED. Здесь нужен счёт порций «которые
// прошли утверждение и кухню готовила». DELIVERED тоже учитывается:
// он завершает PRODUCTION pipeline, мы хотим суммарные порции за период.
const PRODUCTION_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

// ============================================================
// Типы
// ============================================================

export type IngredientBreakdown = {
  ingredientId: string
  name: string
  unit: IngredientUnit
  bruttoGrams: number
  pricePerUnit: number
  /** ₽ вклад этого ингредиента в стоимость одной базовой единицы блюда */
  costContribution: number
}

export type DishCostResult = {
  dishId: string
  dishName: string
  category: DishCategory
  dishUnit: DishUnit
  portionSize: number | null
  /**
   * Стоимость одной порции. null если unit ∈ {LITER, KG} и portionSize
   * не задан (нельзя рассчитать без размера порции).
   * Для PIECE — стоимость одного блока (хлеб, блинчик), так как
   * bruttoGrams в техкарте уже per piece.
   */
  costPerPortion: number | null
  breakdown: IngredientBreakdown[]
  /** true если хотя бы один ингредиент имеет цену 0 (placeholder) */
  hasPlaceholderPrices: boolean
  /**
   * Прокси-цена продажи: средневзвешенная по портиям заказов за последние
   * 30 дней. Вес — portions × MealSetItem.quantity для всех (mealSet, slot),
   * куда попадает категория блюда. null если за 30д не было ни одного
   * заказа подходящего mealType.
   */
  sellPrice: number | null
  /** sellPrice − costPerPortion, округлено до копеек. null если sellPrice или cost null. */
  marginRub: number | null
  /** marginRub / sellPrice × 100, округлено до 1 знака. null если cost или sellPrice null. */
  marginPercent: number | null
  /**
   * % изменения cost за последние 30 дней относительно цены, действовавшей
   * 30 дней назад. Используются IngredientPriceHistory, fallback —
   * текущая Ingredient.pricePerUnit (значит цена не менялась → growth = 0).
   * null если costPerPortion null или oldCost ≤ 0.
   */
  growth30dPercent: number | null
}

// ============================================================
// Хелпер: компиляция DishIngredient[] → breakdown + costPerBaseUnit
// ============================================================

type DishWithIngredients = Prisma.DishGetPayload<{
  include: { ingredients: { include: { ingredient: true } } }
}>

function computeDishCost(
  dish: DishWithIngredients,
  resolver?: PriceResolver,
): DishCostResult {
  const breakdown: IngredientBreakdown[] = []
  let totalCostPerBaseUnit = 0

  for (const di of dish.ingredients) {
    const brutto = Number(di.bruttoGrams)
    const price = resolver ? resolver(di.ingredient.id) : Number(di.ingredient.pricePerUnit)
    // Эталон формулы — material-cost.ts:156-157. PCS → штучная цена,
    // KG/L → грамм/мл, перевод в базу через /1000.
    const costContribution =
      di.ingredient.unit === 'PCS' ? brutto * price : (brutto / 1000) * price

    breakdown.push({
      ingredientId: di.ingredient.id,
      name: di.ingredient.name,
      unit: di.ingredient.unit,
      bruttoGrams: brutto,
      pricePerUnit: price,
      costContribution,
    })
    totalCostPerBaseUnit += costContribution
  }

  const portionSize = dish.portionSize ?? null
  let costPerPortion: number | null
  if (dish.unit === 'PORTION' || dish.unit === 'PIECE') {
    // PORTION — техкарта дана per порцию. PIECE — per штуку (хлеб, блинчик):
    // bruttoGrams уже на одну единицу, как и для PORTION.
    costPerPortion = totalCostPerBaseUnit
  } else if (portionSize !== null) {
    // LITER / KG — техкарта на 1 л / 1 кг. Переводим в порцию через
    // portionSize (в граммах/мл) ÷ 1000.
    costPerPortion = totalCostPerBaseUnit * (portionSize / 1000)
  } else {
    costPerPortion = null
  }

  const hasPlaceholderPrices = breakdown.some(b => b.pricePerUnit === 0)

  return {
    dishId: dish.id,
    dishName: dish.name,
    category: dish.category,
    dishUnit: dish.unit,
    portionSize,
    costPerPortion,
    breakdown,
    hasPlaceholderPrices,
    // Заполняются позже через bulkEnrichDishMetrics (требуют пакетных запросов).
    sellPrice: null,
    marginRub: null,
    marginPercent: null,
    growth30dPercent: null,
  }
}

// ============================================================
// Bulk enrichment: sellPrice / marginRub / marginPercent / growth30dPercent
// ============================================================

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Обогащает каждый DishCostResult полями sellPrice / marginRub / marginPercent
 * / growth30dPercent. Делает максимум 3 пакетных запроса (orders.groupBy +
 * mealSetItem.findMany + ingredientPriceHistory.findMany) для всего списка
 * сразу — не N+1.
 *
 * sellPrice — прокси: средневзвешенная Order.pricePerPortion по mealType-ам,
 * где встречается категория блюда (с весом MealSetItem.quantity × portions).
 * Это та же логика, что в getDishCostExtremes, но пакетно.
 *
 * growth30d — пересчёт costPerPortion с историческими ценами на (now − 30д).
 * Для ингредиентов без priceHistory старше 30д fallback на текущую
 * pricePerUnit (трактуем как «цена не менялась»).
 */
async function bulkEnrichDishMetrics(
  dishes: DishCostResult[],
  options: { mealType?: MealType } = {},
): Promise<void> {
  if (dishes.length === 0) return

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)

  // 1. SellPrice batch — agg Order за 30д по mealType.
  //    totalPrice = portions × pricePerPortion (см. Order schema), поэтому
  //    взвешенная средняя pricePerPortion = sum(totalPrice) / sum(portions).
  const orderAgg = await prisma.order.groupBy({
    by: ['mealType'],
    where: {
      deliveryDate: { gte: thirtyDaysAgo, lte: now },
      status: { in: PRODUCTION_STATUSES },
      ...(options.mealType ? { mealType: options.mealType } : {}),
    },
    _sum: { portions: true, totalPrice: true },
  })

  type MealAgg = { portions: number; avgPrice: number }
  const orderByMealType = new Map<MealType, MealAgg>()
  for (const a of orderAgg) {
    const portions = a._sum.portions ?? 0
    const totalPrice = Number(a._sum.totalPrice ?? 0)
    if (portions > 0) {
      orderByMealType.set(a.mealType, { portions, avgPrice: totalPrice / portions })
    }
  }

  // 2. MealSetItem по категориям всех блюд — для каждой категории список
  //    (mealType, quantity), участвующих в активных наборах.
  const allCats = Array.from(new Set(dishes.map(d => d.category)))
  type MealItem = { mealType: MealType; quantity: number }
  const itemsByCat = new Map<DishCategory, MealItem[]>()
  if (allCats.length > 0) {
    const items = await prisma.mealSetItem.findMany({
      where: {
        dishCategory: { in: allCats },
        mealSet: {
          isActive: true,
          ...(options.mealType ? { mealType: options.mealType } : {}),
        },
      },
      select: {
        dishCategory: true,
        quantity: true,
        mealSet: { select: { mealType: true } },
      },
    })
    for (const it of items) {
      const list = itemsByCat.get(it.dishCategory) ?? []
      list.push({ mealType: it.mealSet.mealType, quantity: it.quantity })
      itemsByCat.set(it.dishCategory, list)
    }
  }

  // 3. IngredientPriceHistory batch — последняя цена ингредиента, действовавшая
  //    к моменту (now − 30д). Если истории нет — fallback на текущую цену.
  const allIngIds = new Set<string>()
  for (const d of dishes) {
    for (const b of d.breakdown) allIngIds.add(b.ingredientId)
  }
  const oldPriceById = new Map<string, number>()
  if (allIngIds.size > 0) {
    const histRows = await prisma.ingredientPriceHistory.findMany({
      where: {
        ingredientId: { in: Array.from(allIngIds) },
        validFrom: { lte: thirtyDaysAgo },
      },
      orderBy: { validFrom: 'desc' },
      select: { ingredientId: true, price: true },
    })
    for (const ph of histRows) {
      // findMany отсортирован desc по validFrom: первая встреченная запись
      // для ingredientId — самая поздняя ≤ thirtyDaysAgo (то что нужно).
      if (!oldPriceById.has(ph.ingredientId)) {
        oldPriceById.set(ph.ingredientId, Number(ph.price))
      }
    }
  }

  // 4. Пройти по каждому блюду — заполнить 4 новых поля.
  for (const d of dishes) {
    // 4a. sellPrice — взвешенная средняя по (mealType, quantity).
    const itemsForCat = itemsByCat.get(d.category) ?? []
    let sumWeighted = 0
    let sumWeight = 0
    for (const it of itemsForCat) {
      const meal = orderByMealType.get(it.mealType)
      if (meal === undefined) continue
      const weight = meal.portions * it.quantity
      sumWeighted += meal.avgPrice * weight
      sumWeight += weight
    }
    d.sellPrice = sumWeight > 0 ? sumWeighted / sumWeight : null

    // 4b. marginRub / marginPercent.
    if (d.sellPrice !== null && d.costPerPortion !== null) {
      d.marginRub = Math.round((d.sellPrice - d.costPerPortion) * 100) / 100
      if (d.sellPrice > 0) {
        d.marginPercent =
          Math.round(((d.sellPrice - d.costPerPortion) / d.sellPrice) * 1000) / 10
      } else {
        d.marginPercent = null
      }
    }

    // 4c. growth30dPercent — пересчёт cost с oldPrices.
    if (d.costPerPortion !== null && d.breakdown.length > 0) {
      let oldTotalPerBase = 0
      for (const b of d.breakdown) {
        // fallback на текущую цену = «не менялась» → вклад в old cost = current
        const price = oldPriceById.get(b.ingredientId) ?? b.pricePerUnit
        const c = b.unit === 'PCS' ? b.bruttoGrams * price : (b.bruttoGrams / 1000) * price
        oldTotalPerBase += c
      }
      let oldCost: number | null
      if (d.dishUnit === 'PORTION' || d.dishUnit === 'PIECE') {
        oldCost = oldTotalPerBase
      } else if (d.portionSize !== null) {
        oldCost = oldTotalPerBase * (d.portionSize / 1000)
      } else {
        oldCost = null
      }
      if (oldCost !== null && oldCost > 0) {
        d.growth30dPercent =
          Math.round(((d.costPerPortion - oldCost) / oldCost) * 1000) / 10
      }
    }
  }
}

// ============================================================
// [A.1] getDishCostNow / getDishCostList
// ============================================================

export async function getDishCostNow(
  dishId: string,
  asOfDate?: Date,
): Promise<DishCostResult | null> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    include: { ingredients: { include: { ingredient: true } } },
  })
  if (!dish) return null

  let result: DishCostResult
  if (asOfDate) {
    const ingredientIds = dish.ingredients.map(di => di.ingredient.id)
    const resolver = await buildPriceResolverForDate(asOfDate, ingredientIds)
    result = computeDishCost(dish, resolver)
  } else {
    result = computeDishCost(dish)
  }

  // Enrich тем же путём что и list — три пакетных запроса даже на одно блюдо
  // не дороже, чем сейчас делает /analytics/cost/[id]/page.tsx.
  await bulkEnrichDishMetrics([result])
  return result
}

/**
 * Определить набор DishCategory, которые встречаются в MealSet с заданным
 * mealType. Используется для фильтрации блюд по mealType, поскольку у Dish
 * нет прямой ссылки на MealSet/MealType (см. шапку файла).
 */
async function getCategoriesForMealType(mealType: MealType): Promise<DishCategory[]> {
  const items = await prisma.mealSetItem.findMany({
    where: { mealSet: { mealType, isActive: true } },
    select: { dishCategory: true },
    distinct: ['dishCategory'],
  })
  return items.map(i => i.dishCategory)
}

export async function getDishCostList(options?: {
  category?: DishCategory
  mealType?: MealType
  includeInactive?: boolean
  asOfDate?: Date
}): Promise<DishCostResult[]> {
  const where: Prisma.DishWhereInput = {}

  if (!options?.includeInactive) {
    where.isActive = true
  }

  if (options?.category) {
    where.category = options.category
  } else if (options?.mealType) {
    // mealType фильтр работает только если category не задан явно
    // (если задан — пусть пройдёт точечная фильтрация по категории).
    const cats = await getCategoriesForMealType(options.mealType)
    if (cats.length === 0) return []
    where.category = { in: cats }
  }

  const dishes = await prisma.dish.findMany({
    where,
    include: { ingredients: { include: { ingredient: true } } },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  let results: DishCostResult[]
  if (options?.asOfDate) {
    // Один пакетный запрос priceHistory на всю выборку.
    const allIds = Array.from(
      new Set(dishes.flatMap(d => d.ingredients.map(di => di.ingredient.id))),
    )
    const resolver = await buildPriceResolverForDate(options.asOfDate, allIds)
    results = dishes.map(d => computeDishCost(d, resolver))
  } else {
    results = dishes.map(d => computeDishCost(d))
  }

  await bulkEnrichDishMetrics(results, { mealType: options?.mealType })
  return results
}

// ============================================================
// [A.2] getAvgDishCostPerPortion
// ============================================================

/**
 * Вариант getMaterialCostForRange с опциональным фильтром по mealType.
 * Логика 1-в-1 повторяет эталон (material-cost.ts), но при наличии
 * mealType:
 *   - в orders.findMany добавляется where.mealType
 *   - при суммировании дня учитывается только день.mealType === mealType
 *
 * Использует историческую цену — для каждого дня цена ингредиента берётся
 * на этот день (priceHistory). Для дат когда истории нет — fallback на
 * текущую pricePerUnit.
 *
 * Сделано отдельной функцией, чтобы НЕ менять сигнатуру / поведение
 * существующего getMaterialCostForRange (см. note в шапке).
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 3600 * 1000

// Локальный helper для per-day исторической цены — намеренное дублирование
// с buildPriceResolverForDate (блок A) и аналогичными хелперами в
// material-cost.ts / ingredients-consumption.ts. Объединение в общий
// helper-файл — следующая волна.
async function buildPriceMapAtDateForRange(
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

export async function getMaterialCostForRangeByMealType(
  from: Date,
  to: Date,
  statuses: OrderStatus[],
  mealType?: MealType,
): Promise<{ totalCost: number; daysWithoutMenu: number; totalDays: number }> {
  const fromMskShifted = new Date(from.getTime() + MSK_OFFSET_MS)
  const startMs =
    Date.UTC(
      fromMskShifted.getUTCFullYear(),
      fromMskShifted.getUTCMonth(),
      fromMskShifted.getUTCDate(),
      0, 0, 0, 0,
    ) - MSK_OFFSET_MS

  const toMskShifted = new Date(to.getTime() + MSK_OFFSET_MS)
  const endMs =
    Date.UTC(
      toMskShifted.getUTCFullYear(),
      toMskShifted.getUTCMonth(),
      toMskShifted.getUTCDate(),
      0, 0, 0, 0,
    ) - MSK_OFFSET_MS

  if (endMs < startMs) {
    return { totalCost: 0, daysWithoutMenu: 0, totalDays: 0 }
  }

  const totalDays = Math.round((endMs - startMs) / ONE_DAY_MS) + 1
  let totalCost = 0
  let daysWithoutMenu = 0

  for (let i = 0; i < totalDays; i++) {
    const dayStart = new Date(startMs + i * ONE_DAY_MS)
    const dayEnd = new Date(dayStart.getTime() + ONE_DAY_MS - 1)
    const dayMskShifted = new Date(dayStart.getTime() + MSK_OFFSET_MS)
    const jsDay = dayMskShifted.getUTCDay()
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    const menu = await prisma.menuCycle.findFirst({
      where: {
        validFrom: { lte: dayStart },
        validTo: { gte: dayStart },
        status: 'APPROVED',
      },
      include: {
        days: {
          where: mealType ? { dayOfWeek, mealType } : { dayOfWeek },
          include: {
            mealSet: { include: { items: true } },
            dishes: {
              include: {
                dish: {
                  include: {
                    ingredients: { include: { ingredient: true } },
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
        ...(mealType ? { mealType } : {}),
      },
      select: { mealType: true, portions: true },
    })

    if (orders.length === 0) continue

    const portionsByMealType: Record<MealType, number> = {
      BREAKFAST: 0,
      LUNCH: 0,
      DINNER: 0,
    }
    for (const o of orders) {
      portionsByMealType[o.mealType] += o.portions
    }

    // Собрать ingredientIds для этого дня и построить per-day priceMap
    // на dayStart (историческая цена). Fallback на pricePerUnit внутри
    // buildPriceMapAtDateForRange (legacy seeds без priceHistory).
    const dayIngredientIds = new Set<string>()
    for (const day of menu.days) {
      for (const menuDish of day.dishes) {
        for (const di of menuDish.dish.ingredients) {
          dayIngredientIds.add(di.ingredientId)
        }
      }
    }
    const priceMap = await buildPriceMapAtDateForRange(dayStart, Array.from(dayIngredientIds))

    for (const day of menu.days) {
      const portions = portionsByMealType[day.mealType]
      if (portions === 0) continue

      const categoryQty = new Map<string, number>()
      if (day.mealSet) {
        for (const item of day.mealSet.items) {
          categoryQty.set(item.dishCategory, item.quantity)
        }
      }

      for (const menuDish of day.dishes) {
        const slotQty = categoryQty.get(menuDish.slotCategory) ?? 1
        const effectivePortions = portions * slotQty
        const dish = menuDish.dish
        for (const di of dish.ingredients) {
          const brutto = Number(di.bruttoGrams)
          const price = priceMap.get(di.ingredientId) ?? Number(di.ingredient.pricePerUnit)
          const costPerPortion =
            di.ingredient.unit === 'PCS' ? brutto * price : (brutto / 1000) * price
          totalCost += costPerPortion * effectivePortions
        }
      }
    }
  }

  return { totalCost, daysWithoutMenu, totalDays }
}

export async function getAvgDishCostPerPortion(
  from: Date,
  to: Date,
  mealType?: MealType,
): Promise<{
  totalCost: number
  totalPortions: number
  avgPerPortion: number | null
  dishesIncluded: number
  hasMissingPortionSize: boolean
}> {
  const { totalCost } = await getMaterialCostForRangeByMealType(
    from, to, PRODUCTION_STATUSES, mealType,
  )

  const portionsAgg = await prisma.order.aggregate({
    _sum: { portions: true },
    where: {
      deliveryDate: { gte: from, lte: to },
      status: { in: PRODUCTION_STATUSES },
      ...(mealType ? { mealType } : {}),
    },
  })
  const totalPortions = portionsAgg._sum.portions ?? 0
  const avgPerPortion = totalPortions > 0 ? totalCost / totalPortions : null

  // dishesIncluded — уникальные dishId, попавшие в APPROVED меню активное
  // в диапазоне [from,to] для нужного mealType. Простая аппроксимация:
  // join MenuDayDish → MenuDay → MenuCycle by validFrom/validTo overlap.
  const menuDayDishes = await prisma.menuDayDish.findMany({
    where: {
      menuDay: {
        ...(mealType ? { mealType } : {}),
        menuCycle: {
          status: 'APPROVED',
          // диапазон цикла пересекается с [from, to]
          validFrom: { lte: to },
          validTo: { gte: from },
        },
      },
    },
    select: { dishId: true },
    distinct: ['dishId'],
  })
  const dishesIncluded = menuDayDishes.length

  // hasMissingPortionSize: блюда с unit ∈ {LITER, KG} и portionSize=null
  // среди активных (опционально под mealType-фильтром).
  const missingWhere: Prisma.DishWhereInput = {
    isActive: true,
    unit: { in: ['LITER', 'KG'] },
    portionSize: null,
  }
  if (mealType) {
    const cats = await getCategoriesForMealType(mealType)
    if (cats.length > 0) missingWhere.category = { in: cats }
    else missingWhere.id = '___never___'
  }
  const missingCount = await prisma.dish.count({ where: missingWhere })

  return {
    totalCost,
    totalPortions,
    avgPerPortion,
    dishesIncluded,
    hasMissingPortionSize: missingCount > 0,
  }
}

// ============================================================
// [A.3] getDishCostHistory (event-driven)
// ============================================================

export type CostHistoryPoint = {
  date: Date
  costPerPortion: number | null
  changedIngredient: {
    id: string
    name: string
    oldPrice: number
    newPrice: number
  }
}

/**
 * Event-driven история стоимости порции. Каждое событие = изменение цены
 * одного из ингредиентов блюда. Между событиями cost постоянна, поэтому
 * UI может строить step-line chart.
 *
 * Алгоритм:
 *  1. Загружаем dish + ingredients + полная история цен каждого ингредиента
 *     (одним запросом — N+1 не делаем).
 *  2. Собираем events: для каждого ингредиента — отрезки validFrom попавшие
 *     в [from, to].
 *  3. Сортируем по date asc.
 *  4. На каждый event резолвим текущую цену каждого ингредиента бинарным
 *     поиском по предзагруженным priceHistory (в памяти).
 *  5. Считаем cost через ту же формулу что и computeDishCost.
 */
export async function getDishCostHistory(
  dishId: string,
  from: Date,
  to: Date,
): Promise<CostHistoryPoint[]> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    include: {
      ingredients: {
        include: {
          ingredient: {
            include: {
              priceHistory: {
                orderBy: { validFrom: 'asc' },
              },
            },
          },
        },
      },
    },
  })
  if (!dish) return []

  // Кеш истории по ingredientId — asc по validFrom, [{ price, validFrom }, ...]
  type PricePoint = { price: number; validFrom: Date }
  const priceHistoryByIng = new Map<string, PricePoint[]>()
  for (const di of dish.ingredients) {
    priceHistoryByIng.set(
      di.ingredient.id,
      di.ingredient.priceHistory.map(ph => ({
        price: Number(ph.price),
        validFrom: ph.validFrom,
      })),
    )
  }

  // Активная цена ингредиента на момент date — последняя priceHistory
  // с validFrom <= date. Если истории до date нет — берём текущую
  // pricePerUnit (fallback, поскольку seed/legacy блюда могут не иметь
  // priceHistory вовсе).
  const currentPriceById = new Map<string, number>()
  for (const di of dish.ingredients) {
    currentPriceById.set(di.ingredient.id, Number(di.ingredient.pricePerUnit))
  }
  function priceAt(ingredientId: string, date: Date): number {
    const hist = priceHistoryByIng.get(ingredientId) ?? []
    // линейный поиск по убыванию (история обычно короткая — десятки точек)
    let result: number | null = null
    for (const p of hist) {
      if (p.validFrom.getTime() <= date.getTime()) result = p.price
      else break
    }
    if (result !== null) return result
    return currentPriceById.get(ingredientId) ?? 0
  }

  // Собираем events в [from, to].
  type Event = {
    date: Date
    ingredientId: string
    ingredientName: string
    newPrice: number
    oldPrice: number
  }
  const events: Event[] = []
  for (const di of dish.ingredients) {
    const hist = priceHistoryByIng.get(di.ingredient.id) ?? []
    for (let i = 0; i < hist.length; i++) {
      const p = hist[i]
      if (p.validFrom.getTime() < from.getTime()) continue
      if (p.validFrom.getTime() > to.getTime()) break
      const oldPrice = i > 0 ? hist[i - 1].price : 0
      events.push({
        date: p.validFrom,
        ingredientId: di.ingredient.id,
        ingredientName: di.ingredient.name,
        newPrice: p.price,
        oldPrice,
      })
    }
  }
  events.sort((a, b) => a.date.getTime() - b.date.getTime())

  // Для каждого event считаем cost (используем ту же логику что и
  // computeDishCost, но через priceAt вместо ingredient.pricePerUnit).
  const result: CostHistoryPoint[] = []
  for (const ev of events) {
    let totalCostPerBaseUnit = 0
    for (const di of dish.ingredients) {
      const brutto = Number(di.bruttoGrams)
      const price = priceAt(di.ingredient.id, ev.date)
      const c =
        di.ingredient.unit === 'PCS'
          ? brutto * price
          : (brutto / 1000) * price
      totalCostPerBaseUnit += c
    }

    let costPerPortion: number | null
    if (dish.unit === 'PORTION' || dish.unit === 'PIECE') {
      costPerPortion = totalCostPerBaseUnit
    } else if (dish.portionSize !== null) {
      costPerPortion = totalCostPerBaseUnit * (dish.portionSize / 1000)
    } else {
      costPerPortion = null
    }

    result.push({
      date: ev.date,
      costPerPortion,
      changedIngredient: {
        id: ev.ingredientId,
        name: ev.ingredientName,
        oldPrice: ev.oldPrice,
        newPrice: ev.newPrice,
      },
    })
  }

  return result
}

// ============================================================
// [A.5] getDishUsageInMealSets
// ============================================================

/**
 * «Использование блюда в MealSet». Поскольку MealSetItem связан с блюдом
 * только через категорию, ВСЕ блюда категории X считаются «используемыми»
 * в любом MealSet, имеющем item категории X.
 *
 * Возвращает по одной строке на (mealSet, slotCategory=dish.category) —
 * сколько штук этой категории закрывает блюдо в наборе.
 */
export async function getDishUsageInMealSets(dishId: string): Promise<Array<{
  mealSetId: string
  mealSetName: string
  mealType: MealType
  slotCategory: DishCategory
  quantity: number
}>> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    select: { id: true, category: true },
  })
  if (!dish) return []

  const items = await prisma.mealSetItem.findMany({
    where: {
      dishCategory: dish.category,
      mealSet: { isActive: true },
    },
    include: {
      mealSet: { select: { id: true, name: true, mealType: true } },
    },
    orderBy: [{ mealSet: { mealType: 'asc' } }, { mealSet: { name: 'asc' } }],
  })

  return items.map(it => ({
    mealSetId: it.mealSet.id,
    mealSetName: it.mealSet.name,
    mealType: it.mealSet.mealType,
    slotCategory: it.dishCategory,
    quantity: it.quantity,
  }))
}
