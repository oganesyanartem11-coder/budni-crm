import { PrismaClient, type DishCategory, type MealType } from '@prisma/client'

// Понедельник текущей недели (00:00 локальное время)
function getMondayOfCurrentWeek(): Date {
  const now = new Date()
  const day = now.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

interface DayMenu {
  dayOfWeek: number // 1..7 ISO
  lunch: { soup: string; main: string; garnish: string; salad: string; dessert: string }
  dinner: { main: string; garnish: string }
  breakfast: { porridge: string }
}

const WEEK: DayMenu[] = [
  { dayOfWeek: 1, lunch: { soup: 'Борщ',                main: 'Котлеты домашние',           garnish: 'Картофельное пюре', salad: 'Салат "Витаминный"',          dessert: 'Печенье песочное' }, dinner: { main: 'Куриные биточки',         garnish: 'Гречка отварная' },     breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 2, lunch: { soup: 'Куриная лапша',       main: 'Гуляш из говядины',           garnish: 'Гречка отварная',   salad: 'Салат "Свежесть"',            dessert: 'Сырник' },           dinner: { main: 'Тефтели в томатном соусе', garnish: 'Рис отварной' },        breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 3, lunch: { soup: 'Солянка мясная',      main: 'Тефтели в томатном соусе',    garnish: 'Рис отварной',      salad: 'Винегрет',                    dessert: 'Шарлотка яблочная' },dinner: { main: 'Куриная грудка запечённая',garnish: 'Макароны отварные' },   breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 4, lunch: { soup: 'Гороховый суп',       main: 'Свинина по-домашнему',        garnish: 'Макароны отварные', salad: 'Салат "Морковный с чесноком"',dessert: 'Печенье песочное' }, dinner: { main: 'Котлеты домашние',         garnish: 'Картофельное пюре' },   breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 5, lunch: { soup: 'Щи из свежей капусты',main: 'Куриная грудка запечённая',   garnish: 'Тушёная капуста',   salad: 'Салат "Свежесть"',            dessert: 'Сырник' },           dinner: { main: 'Гуляш из говядины',        garnish: 'Гречка отварная' },     breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 6, lunch: { soup: 'Борщ',                main: 'Гуляш из говядины',           garnish: 'Картофельное пюре', salad: 'Винегрет',                    dessert: 'Шарлотка яблочная' },dinner: { main: 'Свинина по-домашнему',     garnish: 'Рис отварной' },        breakfast: { porridge: 'Овсяная каша на молоке' } },
  { dayOfWeek: 7, lunch: { soup: 'Куриная лапша',       main: 'Котлеты домашние',            garnish: 'Гречка отварная',   salad: 'Салат "Витаминный"',          dessert: 'Печенье песочное' }, dinner: { main: 'Куриные биточки',         garnish: 'Макароны отварные' },   breakfast: { porridge: 'Овсяная каша на молоке' } },
]

// Общие для всех дней
const COMMON_LUNCH_DRINK = 'Компот из сухофруктов'
const COMMON_BREAD_WHITE = 'Хлеб белый'
const COMMON_BREAD_DARK = 'Хлеб чёрный'
const COMMON_DINNER_DRINK = 'Компот из сухофруктов'
const COMMON_DINNER_PANCAKE = 'Блинчики с творогом'
const COMMON_BREAKFAST_EGGS = 'Омлет'
const COMMON_BREAKFAST_DRINK = 'Компот из сухофруктов'

export async function seedMenu(
  prisma: PrismaClient,
  dishMap: Map<string, string>,
  mealSetMap: Map<string, string>
): Promise<{ name: string }> {
  const monday = getMondayOfCurrentWeek()
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)

  const cycleName = `Меню недели ${monday.toLocaleDateString('ru-RU')} – ${sunday.toLocaleDateString('ru-RU')}`

  // Upsert цикла
  let cycle = await prisma.menuCycle.findFirst({
    where: { validFrom: monday },
  })
  if (cycle) {
    await prisma.menuDay.deleteMany({ where: { menuCycleId: cycle.id } })
  } else {
    cycle = await prisma.menuCycle.create({
      data: {
        name: cycleName,
        validFrom: monday,
        validTo: sunday,
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    })
  }

  function dishId(name: string): string {
    const id = dishMap.get(name)
    if (!id) throw new Error(`Блюдо "${name}" не найдено`)
    return id
  }

  for (const day of WEEK) {
    // LUNCH
    const lunchDay = await prisma.menuDay.create({
      data: {
        menuCycleId: cycle.id,
        dayOfWeek: day.dayOfWeek,
        mealType: 'LUNCH',
        mealSetId: mealSetMap.get('LUNCH'),
      },
    })
    const lunchDishes: Array<[DishCategory, string]> = [
      ['SOUP', day.lunch.soup],
      ['MAIN', day.lunch.main],
      ['GARNISH', day.lunch.garnish],
      ['SALAD', day.lunch.salad],
      ['DESSERT', day.lunch.dessert],
      ['DRINK', COMMON_LUNCH_DRINK],
      ['BREAD_WHITE', COMMON_BREAD_WHITE],
      ['BREAD_DARK', COMMON_BREAD_DARK],
    ]
    for (const [cat, name] of lunchDishes) {
      await prisma.menuDayDish.create({
        data: { menuDayId: lunchDay.id, dishId: dishId(name), slotCategory: cat },
      })
    }

    // DINNER
    const dinnerDay = await prisma.menuDay.create({
      data: {
        menuCycleId: cycle.id,
        dayOfWeek: day.dayOfWeek,
        mealType: 'DINNER',
        mealSetId: mealSetMap.get('DINNER'),
      },
    })
    const dinnerDishes: Array<[DishCategory, string]> = [
      ['MAIN', day.dinner.main],
      ['GARNISH', day.dinner.garnish],
      ['PANCAKE', COMMON_DINNER_PANCAKE],
      ['BREAD_WHITE', COMMON_BREAD_WHITE],
      ['DRINK', COMMON_DINNER_DRINK],
    ]
    for (const [cat, name] of dinnerDishes) {
      await prisma.menuDayDish.create({
        data: { menuDayId: dinnerDay.id, dishId: dishId(name), slotCategory: cat },
      })
    }

    // BREAKFAST
    const breakfastDay = await prisma.menuDay.create({
      data: {
        menuCycleId: cycle.id,
        dayOfWeek: day.dayOfWeek,
        mealType: 'BREAKFAST',
        mealSetId: mealSetMap.get('BREAKFAST'),
      },
    })
    const breakfastDishes: Array<[DishCategory, string]> = [
      ['PORRIDGE', day.breakfast.porridge],
      ['EGGS', COMMON_BREAKFAST_EGGS],
      ['DRINK', COMMON_BREAKFAST_DRINK],
    ]
    for (const [cat, name] of breakfastDishes) {
      await prisma.menuDayDish.create({
        data: { menuDayId: breakfastDay.id, dishId: dishId(name), slotCategory: cat },
      })
    }
  }

  return { name: cycle.name }
}
