import { prisma } from '@/lib/db/prisma'
import type { MealType, OrderStatus } from '@prisma/client'

const PRODUCTION_STATUSES: OrderStatus[] = [
  'CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY',
]

export interface DishProductionRow {
  dishId: string
  dishName: string
  category: string
  mealType: MealType
  totalPortions: number
  ordersCount: number
  locationsCount: number
}

export interface ProductionSummary {
  date: string // ISO date
  mealTypes: Record<MealType, {
    totalPortions: number
    totalRevenue: number
    dishes: DishProductionRow[]
    menuApproved: boolean // утверждено ли меню для этой даты
  }>
  pendingPortions: number // сколько порций в PENDING на эту дату
  totalPortions: number
  totalRevenue: number
  hasMenu: boolean
}

/**
 * Вычисляет производственную сводку на дату.
 *
 * Алгоритм:
 * 1. Грузим все заказы на дату в активных статусах + считаем PENDING отдельно
 * 2. Грузим MenuCycle активного меню на эту неделю с MenuDay для нужного dayOfWeek
 * 3. Для каждого типа питания (Завтрак/Обед/Ужин):
 *    - Суммируем порции из заказов
 *    - Берём блюда из MenuDay (для соответствующего mealType)
 *    - Каждое блюдо × сумма порций = столько надо приготовить
 */
export async function getProductionSummary(targetDate: Date): Promise<ProductionSummary> {
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  // 1. Заказы на дату
  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: { in: PRODUCTION_STATUSES },
    },
    select: {
      id: true,
      mealType: true,
      portions: true,
      totalPrice: true,
      locationId: true,
    },
  })

  const pendingOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: 'PENDING_CONFIRMATION',
    },
    select: { portions: true, sourceConfig: { select: { fixedPortions: true } } },
  })

  // PENDING могут иметь portions=0 (placeholder), но fixedPortions из конфига даёт оценку
  const pendingPortions = pendingOrders.reduce((sum, o) => {
    const estimate = o.portions > 0 ? o.portions : (o.sourceConfig?.fixedPortions ?? 0)
    return sum + estimate
  }, 0)

  // 2. День недели от заданной даты (1-7, понедельник = 1)
  const jsDay = date.getDay()
  const dayOfWeek = jsDay === 0 ? 7 : jsDay

  // 3. Активное меню на неделю содержащую эту дату
  // Для упрощения ищем MenuCycle где validFrom <= date <= validTo
  const menu = await prisma.menuCycle.findFirst({
    where: {
      validFrom: { lte: date },
      validTo: { gte: date },
      status: 'APPROVED',
    },
    include: {
      days: {
        where: { dayOfWeek },
        include: {
          dishes: {
            include: { dish: true },
          },
        },
      },
    },
  })

  // 4. Группируем заказы по mealType
  const byMealType: Record<MealType, {
    portions: number
    revenue: number
    locationIds: Set<string>
    ordersCount: number
  }> = {
    BREAKFAST: { portions: 0, revenue: 0, locationIds: new Set(), ordersCount: 0 },
    LUNCH: { portions: 0, revenue: 0, locationIds: new Set(), ordersCount: 0 },
    DINNER: { portions: 0, revenue: 0, locationIds: new Set(), ordersCount: 0 },
  }

  for (const o of orders) {
    const mt = byMealType[o.mealType]
    mt.portions += o.portions
    mt.revenue += Number(o.totalPrice)
    mt.locationIds.add(o.locationId)
    mt.ordersCount += 1
  }

  // 5. Формируем итоговый отчёт по типам питания
  const mealTypes: ProductionSummary['mealTypes'] = {
    BREAKFAST: { totalPortions: 0, totalRevenue: 0, dishes: [], menuApproved: false },
    LUNCH: { totalPortions: 0, totalRevenue: 0, dishes: [], menuApproved: false },
    DINNER: { totalPortions: 0, totalRevenue: 0, dishes: [], menuApproved: false },
  }

  const allMealTypes: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']
  for (const mt of allMealTypes) {
    const data = byMealType[mt]
    mealTypes[mt].totalPortions = data.portions
    mealTypes[mt].totalRevenue = data.revenue
    mealTypes[mt].menuApproved = !!menu

    if (!menu || data.portions === 0) continue

    // Находим MenuDay для этого mealType
    const menuDay = menu.days.find((d) => d.mealType === mt)
    if (!menuDay || menuDay.dishes.length === 0) continue

    // Каждое блюдо × portions
    mealTypes[mt].dishes = menuDay.dishes.map((md) => ({
      dishId: md.dish.id,
      dishName: md.dish.name,
      category: md.slotCategory,
      mealType: mt,
      totalPortions: data.portions,
      ordersCount: data.ordersCount,
      locationsCount: data.locationIds.size,
    }))
  }

  const totalPortions = Object.values(mealTypes).reduce((s, m) => s + m.totalPortions, 0)
  const totalRevenue = Object.values(mealTypes).reduce((s, m) => s + m.totalRevenue, 0)

  return {
    date: date.toISOString(),
    mealTypes,
    pendingPortions,
    totalPortions,
    totalRevenue,
    hasMenu: !!menu,
  }
}

export interface IngredientUsage {
  dishId: string
  dishName: string
  bruttoPerPortion: number // в граммах или штуках
  unit: string // 'KG', 'L', 'PCS' (из DishUnit; для расчёта берём brutto в граммах если KG/L, в штуках если PCS)
  portions: number
  totalNeeded: number // bruttoPerPortion × portions, в исходных единицах ингредиента
}

export interface IngredientProductionRow {
  ingredientId: string
  ingredientName: string
  unit: 'KG' | 'L' | 'PCS' // единица ингредиента
  totalNeeded: number // в единицах ингредиента
  pricePerUnit: number
  totalCost: number
  usages: IngredientUsage[] // в каких блюдах используется
}

export interface IngredientsSummary {
  date: string
  rows: IngredientProductionRow[]
  totalCost: number // сумма закупки
  totalRevenue: number // выручка
  estimatedMargin: number // revenue - cost
  hasMenu: boolean
}

/**
 * Сводка по сырью на дату. Использует ту же логику расчёта порций,
 * что и getProductionSummary, но идёт глубже — в DishIngredient,
 * чтобы суммировать потребности по каждому ингредиенту.
 */
export async function getIngredientsSummary(targetDate: Date): Promise<IngredientsSummary> {
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  // 1. Заказы на дату — повторяем логику из getProductionSummary
  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: { in: PRODUCTION_STATUSES },
    },
    select: { mealType: true, portions: true, totalPrice: true },
  })

  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.totalPrice), 0)

  // 2. Группируем порции по mealType
  const portionsByMealType: Record<MealType, number> = {
    BREAKFAST: 0,
    LUNCH: 0,
    DINNER: 0,
  }
  for (const o of orders) {
    portionsByMealType[o.mealType] += o.portions
  }

  // 3. День недели и активное меню
  const jsDay = date.getDay()
  const dayOfWeek = jsDay === 0 ? 7 : jsDay

  const menu = await prisma.menuCycle.findFirst({
    where: {
      validFrom: { lte: date },
      validTo: { gte: date },
      status: 'APPROVED',
    },
    include: {
      days: {
        where: { dayOfWeek },
        include: {
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
    return {
      date: date.toISOString(),
      rows: [],
      totalCost: 0,
      totalRevenue,
      estimatedMargin: totalRevenue,
      hasMenu: false,
    }
  }

  // 4. Идём по всем блюдам всех типов питания, считаем суммарную потребность по ингредиентам
  const ingredientsMap = new Map<string, IngredientProductionRow>()

  for (const day of menu.days) {
    const portions = portionsByMealType[day.mealType]
    if (portions === 0) continue

    for (const menuDish of day.dishes) {
      const dish = menuDish.dish

      for (const di of dish.ingredients) {
        const ing = di.ingredient
        const bruttoNum = Number(di.bruttoGrams)

        // Конвертация: для KG/L brutto в граммах/мл → переводим в кг/л
        // для PCS — brutto уже в штуках на 1 порцию
        let neededInIngredientUnit: number
        if (ing.unit === 'KG' || ing.unit === 'L') {
          neededInIngredientUnit = (bruttoNum / 1000) * portions
        } else {
          neededInIngredientUnit = bruttoNum * portions
        }

        const existing = ingredientsMap.get(ing.id)
        if (existing) {
          existing.totalNeeded += neededInIngredientUnit
          existing.usages.push({
            dishId: dish.id,
            dishName: dish.name,
            bruttoPerPortion: bruttoNum,
            unit: ing.unit,
            portions,
            totalNeeded: neededInIngredientUnit,
          })
        } else {
          const pricePerUnit = Number(ing.pricePerUnit)
          ingredientsMap.set(ing.id, {
            ingredientId: ing.id,
            ingredientName: ing.name,
            unit: ing.unit,
            totalNeeded: neededInIngredientUnit,
            pricePerUnit,
            totalCost: 0, // финальный пересчёт ниже
            usages: [{
              dishId: dish.id,
              dishName: dish.name,
              bruttoPerPortion: bruttoNum,
              unit: ing.unit,
              portions,
              totalNeeded: neededInIngredientUnit,
            }],
          })
        }
      }
    }
  }

  // Финальный пересчёт totalCost (после того как все потребности просуммированы)
  for (const row of ingredientsMap.values()) {
    row.totalCost = row.totalNeeded * row.pricePerUnit
  }

  // Сортировка по totalCost убывающе (самое дорогое сверху)
  const rows = Array.from(ingredientsMap.values()).sort((a, b) => b.totalCost - a.totalCost)
  const totalCost = rows.reduce((sum, r) => sum + r.totalCost, 0)

  return {
    date: date.toISOString(),
    rows,
    totalCost,
    totalRevenue,
    estimatedMargin: totalRevenue - totalCost,
    hasMenu: true,
  }
}
