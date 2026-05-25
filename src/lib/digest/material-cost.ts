import { prisma } from '@/lib/db/prisma'
import type { MealType, OrderStatus } from '@prisma/client'

export type MaterialCostResult = {
  totalCost: number
  daysWithoutMenu: number
  totalDays: number
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

// MSK = UTC+3 круглый год (нет DST). Используется для нормализации
// границ диапазона к MSK-полуночи независимо от TZ серверного процесса.
const MSK_OFFSET_MS = 3 * 3600 * 1000

/**
 * Себестоимость сырья за диапазон дат [from, to] включительно.
 * Логика per-day идентична getIngredientsSummary (production.ts:200-342),
 * без хардкода статусов (передаются параметром).
 *
 * Использует ТЕКУЩУЮ цену Ingredient.pricePerUnit (не historical) —
 * historical price на эту итерацию вне scope (см. отчёт разведки 6.5).
 * Учитывает MealSetItem.quantity (Sprint 7.11 O-3): набор может включать
 * несколько штук одной категории (например, 2 хлеба на обед).
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
  // Нормализуем границы к MSK-полуночи дня в котором лежит from/to.
  // Раньше использовался setHours(0,0,0,0) локально; на UTC-сервере это
  // ломало totalDays для диапазонов, чьи from/to уже представлены в
  // MSK-семантике (после fix getFinancialWeek 6.6: from=21:00Z пред.дня,
  // to=20:59:59Z). См. arithmetic в getFinancialWeek (utils/week.ts).
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
    return { totalCost: 0, daysWithoutMenu: 0, totalDays: 0 }
  }

  const totalDays = Math.round((endMs - startMs) / ONE_DAY_MS) + 1

  let totalCost = 0
  let daysWithoutMenu = 0

  for (let i = 0; i < totalDays; i++) {
    const dayStart = new Date(startMs + i * ONE_DAY_MS)
    // MSK-конец дня = MSK-полночь следующего дня − 1мс. lte: dayEnd
    // эквивалентно lt: dayStart+24h, но lte привычнее для диапазонов.
    const dayEnd = new Date(dayStart.getTime() + ONE_DAY_MS - 1)

    // 1. День недели в MSK (ISO: 1=Пн, 7=Вс). Считаем от MSK-shifted
    //    точки, иначе на UTC-сервере dayStart=21:00Z даст getDay() от
    //    предыдущего календарного дня.
    const dayMskShifted = new Date(dayStart.getTime() + MSK_OFFSET_MS)
    const jsDay = dayMskShifted.getUTCDay()
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
    //    Учитываем MealSetItem.quantity на slotCategory (Sprint 7.11 O-3).
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
          const price = Number(di.ingredient.pricePerUnit)
          const costPerPortion =
            di.ingredient.unit === 'PCS' ? brutto * price : (brutto / 1000) * price
          totalCost += costPerPortion * effectivePortions
        }
      }
    }
  }

  return { totalCost, daysWithoutMenu, totalDays }
}
