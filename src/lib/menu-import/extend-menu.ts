import type { Prisma } from '@prisma/client'
import { isMonday, type MenuImportStructure } from './expand-menu'

type Tx = Prisma.TransactionClient

export interface ActiveMenuInfo {
  menuImportId: string
  /** Воскресенье последнего MenuCycle. */
  lastValidTo: Date
  /** Сколько MenuCycle уже создано для этого MenuImport. */
  cyclesCount: number
}

/**
 * Находит «активное меню» — APPROVED MenuImport с самым последним разворотом
 * в будущее. Активность определяется по MenuCycle.validFrom: побеждает тот
 * MenuImport, у которого есть цикл с максимальным validFrom (т.е. он будет
 * действовать дальше всех в будущем).
 *
 * Возвращает null если:
 * - Никаких APPROVED MenuImport с MenuCycle нет.
 * - Все MenuCycle уже истекли (validTo < сейчас).
 */
export async function findActiveMenuForExtension(tx: Tx): Promise<ActiveMenuInfo | null> {
  // Берём цикл с максимальным validFrom среди привязанных к MenuImport.
  // status:APPROVED — отсекает архивные/черновые циклы.
  const latestCycle = await tx.menuCycle.findFirst({
    where: {
      menuImportId: { not: null },
      status: 'APPROVED',
    },
    orderBy: { validFrom: 'desc' },
    select: {
      menuImportId: true,
      validTo: true,
    },
  })

  if (!latestCycle?.menuImportId) return null

  // Считаем сколько циклов привязано к этому MenuImport — для чередования
  // A/B при продлении (см. extendMenuPlan.startOffset).
  const cyclesCount = await tx.menuCycle.count({
    where: { menuImportId: latestCycle.menuImportId, status: 'APPROVED' },
  })

  return {
    menuImportId: latestCycle.menuImportId,
    lastValidTo: latestCycle.validTo,
    cyclesCount,
  }
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

/**
 * Расширенный аналог expandMenuFromStructure для автопродления через cron.
 * Отличается двумя вещами:
 *
 * 1. approvedById: string | null — у cron'а нет пользователя; передаём null,
 *    в БД approvedById nullable.
 * 2. startOffset: 0 | 1 — продолжает чередование A/B от существующих циклов.
 *    Если до продления было N циклов и N чётное, startOffset = 0 (новый блок
 *    начинается с A). Если N нечётное — startOffset = 1 (начинаем с Б), чтобы
 *    последний A в существующем меню не дублировался первым A в продлении.
 *
 * Оригинальная expandMenuFromStructure не изменяется (8.7 контракт).
 */
export async function extendMenuPlan(
  structure: MenuImportStructure,
  startDate: Date,
  weeksAhead: number,
  menuImportId: string,
  approvedById: string | null,
  startOffset: 0 | 1,
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
    const isWeekA = (i + startOffset) % 2 === 0 || structure.weekB === null
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
