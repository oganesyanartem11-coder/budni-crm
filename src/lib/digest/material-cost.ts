import { prisma } from '@/lib/db/prisma'
import type { MealType, OrderStatus } from '@prisma/client'

export type MaterialCostResult = {
  totalCost: number
  daysWithoutMenu: number
  totalDays: number
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Себестоимость сырья за диапазон дат [from, to] включительно.
 * Логика per-day идентична getIngredientsSummary (production.ts:200-342),
 * но без хардкода статусов и без MealSetItem.quantity.
 *
 * Использует ТЕКУЩУЮ цену Ingredient.pricePerUnit (не historical) —
 * historical price на эту итерацию вне scope (см. отчёт разведки 6.5).
 * Не учитывает MealSetItem.quantity (consistency с UI getIngredientsSummary).
 *
 * daysWithoutMenu — дни в диапазоне, для которых нет активного APPROVED
 * MenuCycle. Передаётся наверх, чтобы вызывающий мог пометить маржу как
 * частичную («есть N дней без меню — себестоимость занижена»).
 */
export async function getMaterialCostForRange(
  from: Date,
  to: Date,
  statuses: OrderStatus[]
): Promise<MaterialCostResult> {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)

  if (end.getTime() < start.getTime()) {
    return { totalCost: 0, daysWithoutMenu: 0, totalDays: 0 }
  }

  const totalDays = Math.round((end.getTime() - start.getTime()) / ONE_DAY_MS) + 1

  let totalCost = 0
  let daysWithoutMenu = 0

  for (let i = 0; i < totalDays; i++) {
    const dayStart = new Date(start.getTime() + i * ONE_DAY_MS)
    const dayEnd = new Date(dayStart)
    dayEnd.setHours(23, 59, 59, 999)

    // 1. День недели (ISO: 1=Пн, 7=Вс).
    const jsDay = dayStart.getDay()
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    // 2. Активное APPROVED меню на этот день. Проверяем БЕЗУСЛОВНО, до
    //    выгрузки заказов: daysWithoutMenu отражает «дни без утверждённого
    //    меню в принципе», независимо от того, были ли заказы.
    const menu = await prisma.menuCycle.findFirst({
      where: {
        validFrom: { lte: dayStart },
        validTo: { gte: dayStart },
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
      daysWithoutMenu++
      continue
    }

    // 3. Заказы на дату с фильтром по статусам, агрегируем порции по mealType.
    const orders = await prisma.order.findMany({
      where: {
        deliveryDate: { gte: dayStart, lte: dayEnd },
        status: { in: statuses },
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

    // 4. Считаем стоимость дня: по всем MenuDay (mealType-ам) для которых
    //    есть порции — суммируем по блюдам и их ингредиентам.
    for (const day of menu.days) {
      const portions = portionsByMealType[day.mealType]
      if (portions === 0) continue

      for (const menuDish of day.dishes) {
        const dish = menuDish.dish
        for (const di of dish.ingredients) {
          const brutto = Number(di.bruttoGrams)
          const price = Number(di.ingredient.pricePerUnit)
          const costPerPortion =
            di.ingredient.unit === 'PCS' ? brutto * price : (brutto / 1000) * price
          totalCost += costPerPortion * portions
        }
      }
    }
  }

  return { totalCost, daysWithoutMenu, totalDays }
}
