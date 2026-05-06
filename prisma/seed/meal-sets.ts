import { PrismaClient, type DishCategory, type MealType } from '@prisma/client'

interface MealSetSeed {
  mealType: MealType
  name: string
  isDefault: boolean
  items: Array<{ category: DishCategory; quantity: number }>
}

const MEAL_SETS: MealSetSeed[] = [
  {
    mealType: 'BREAKFAST',
    name: 'Завтрак стандарт',
    isDefault: true,
    items: [
      { category: 'PORRIDGE', quantity: 1 },
      { category: 'EGGS', quantity: 1 },
      { category: 'DRINK', quantity: 1 },
    ],
  },
  {
    mealType: 'LUNCH',
    name: 'Обед стандарт',
    isDefault: true,
    items: [
      { category: 'SOUP', quantity: 1 },
      { category: 'MAIN', quantity: 1 },
      { category: 'GARNISH', quantity: 1 },
      { category: 'SALAD', quantity: 1 },
      { category: 'DESSERT', quantity: 1 },
      { category: 'BREAD_WHITE', quantity: 2 },
      { category: 'BREAD_DARK', quantity: 1 },
      { category: 'DRINK', quantity: 1 },
    ],
  },
  {
    mealType: 'DINNER',
    name: 'Ужин стандарт',
    isDefault: true,
    items: [
      { category: 'MAIN', quantity: 1 },
      { category: 'GARNISH', quantity: 1 },
      { category: 'PANCAKE', quantity: 2 },
      { category: 'BREAD_WHITE', quantity: 1 },
      { category: 'DRINK', quantity: 1 },
    ],
  },
]

export async function seedMealSets(prisma: PrismaClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  for (const set of MEAL_SETS) {
    const existing = await prisma.mealSet.findFirst({
      where: { mealType: set.mealType, name: set.name },
    })

    let setId: string
    if (existing) {
      setId = existing.id
      await prisma.mealSetItem.deleteMany({ where: { mealSetId: setId } })
    } else {
      const created = await prisma.mealSet.create({
        data: {
          mealType: set.mealType,
          name: set.name,
          isDefault: set.isDefault,
        },
      })
      setId = created.id
    }

    for (const item of set.items) {
      await prisma.mealSetItem.create({
        data: {
          mealSetId: setId,
          dishCategory: item.category,
          quantity: item.quantity,
        },
      })
    }

    map.set(set.mealType, setId)
  }

  return map
}
