import type { DishCategory, MealType, Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

export interface DishSlot {
  dishId: string
  slotCategory: DishCategory
}

export interface WeekDay {
  dayOfWeek: number
  mealType: MealType
  dishes: DishSlot[]
}

export interface WeekStructure {
  days: WeekDay[]
}

export interface MenuImportStructure {
  weekA: WeekStructure
  weekB: WeekStructure | null
}

// UTC чтобы дата, построенная как new Date('YYYY-MM-DDT00:00:00.000Z'), не сдвигалась
// на нелокальном сервере (Vercel в US — getDay() вернул бы воскресенье для UTC-понедельника).
export function isMonday(date: Date): boolean {
  return date.getUTCDay() === 1
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + n)
  return r
}

function formatDayMonth(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}`
}

// Собирает структуру исходного импорта в виде {weekA, weekB?} — что развернётся
// при approve. Источник правды для связи «цикл принадлежит этому импорту» —
// Dish.menuImportId (тот же критерий, что использует rollbackMenuImport в assemble.ts).
// Сортировка циклов по validFrom asc: первый = A, второй = B; третий и далее
// игнорируются (контракт 8.6: импорт максимум на 2 недели).
//
// slotCategory сразу включаем в выходную структуру, чтобы expandMenuFromStructure
// не делал отдельный lookup Dish per dishId внутри транзакции.
export async function getMenuStructureFromImport(
  menuImportId: string,
  tx: Tx
): Promise<MenuImportStructure> {
  const cycles = await tx.menuCycle.findMany({
    where: {
      days: { some: { dishes: { some: { dish: { menuImportId } } } } },
    },
    orderBy: { validFrom: 'asc' },
    include: {
      days: {
        orderBy: [{ dayOfWeek: 'asc' }, { mealType: 'asc' }],
        include: {
          dishes: { select: { dishId: true, slotCategory: true } },
        },
      },
    },
  })

  const toWeekStructure = (
    days: Array<{
      dayOfWeek: number
      mealType: MealType
      dishes: Array<{ dishId: string; slotCategory: DishCategory }>
    }>
  ): WeekStructure => ({
    days: days
      .filter((d) => d.dishes.length > 0)
      .map((d) => ({
        dayOfWeek: d.dayOfWeek,
        mealType: d.mealType,
        dishes: d.dishes.map((md) => ({ dishId: md.dishId, slotCategory: md.slotCategory })),
      })),
  })

  const weekA = cycles[0] ? toWeekStructure(cycles[0].days) : { days: [] }
  const weekB = cycles[1] ? toWeekStructure(cycles[1].days) : null

  return { weekA, weekB }
}

// Создаёт weeksAhead новых MenuCycle от startDate (понедельник). Чередование:
// index 0 → A, index 1 → B (если B != null), 2 → A, ... Если B == null — все недели A.
// Новые MenuCycle имеют status='APPROVED', menuImportId, approvedById/At.
// Dish переиспользуются — только ссылки через dishId, никаких tx.dish.create.
export async function expandMenuFromStructure(
  structure: MenuImportStructure,
  startDate: Date,
  weeksAhead: number,
  menuImportId: string,
  approvedById: string,
  tx: Tx
): Promise<number> {
  if (!isMonday(startDate)) {
    throw new Error('startDate должен быть понедельником')
  }
  if (structure.weekA.days.length === 0) {
    throw new Error('Нет данных для разворачивания (структура недели A пустая)')
  }

  const approvedAt = new Date()
  let cyclesCreated = 0

  for (let i = 0; i < weeksAhead; i++) {
    const isWeekA = i % 2 === 0 || structure.weekB === null
    const week = isWeekA ? structure.weekA : structure.weekB!
    const validFrom = addDays(startDate, i * 7)
    const validTo = addDays(validFrom, 6)
    const weekLabel = isWeekA ? 'А' : 'Б'
    const name = `Неделя ${weekLabel}, ${formatDayMonth(validFrom)} - ${formatDayMonth(validTo)}`

    const cycle = await tx.menuCycle.create({
      data: {
        name,
        validFrom,
        validTo,
        status: 'APPROVED',
        menuImportId,
        approvedById,
        approvedAt,
      },
    })
    cyclesCreated++

    for (const day of week.days) {
      const menuDay = await tx.menuDay.create({
        data: { menuCycleId: cycle.id, dayOfWeek: day.dayOfWeek, mealType: day.mealType },
      })
      if (day.dishes.length > 0) {
        await tx.menuDayDish.createMany({
          data: day.dishes.map((d) => ({
            menuDayId: menuDay.id,
            dishId: d.dishId,
            slotCategory: d.slotCategory,
          })),
        })
      }
    }
  }

  return cyclesCreated
}
