'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { getMondayOfWeek, getSundayOfWeek } from '@/lib/utils/week'
import type { DishCategory, MealType } from '@prisma/client'

const createMenuSchema = z.object({
  weekStartIso: z.string(), // ISO date string понедельника недели
})

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/**
 * Создаёт пустой черновик меню для заданной недели.
 * Сразу создаёт MenuDay для каждого из 7 дней × 3 типов питания (с привязкой к default MealSet).
 * Блюда — пусто, шеф наполняет позже.
 */
export async function createDraftMenu(weekStartIso: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = createMenuSchema.safeParse({ weekStartIso })
  if (!parsed.success) {
    return { ok: false, error: 'Неверная дата недели' }
  }

  const monday = getMondayOfWeek(new Date(parsed.data.weekStartIso))
  const sunday = getSundayOfWeek(monday)

  // Проверяем — нет ли уже меню на эту неделю
  const existing = await prisma.menuCycle.findFirst({
    where: {
      validFrom: monday,
    },
  })

  if (existing) {
    return { ok: false, error: 'Меню на эту неделю уже существует' }
  }

  // Загружаем default MealSet для каждого типа питания
  const mealSets = await prisma.mealSet.findMany({
    where: { isDefault: true, isActive: true },
  })

  const mealSetByType = new Map<MealType, string>()
  for (const ms of mealSets) {
    mealSetByType.set(ms.mealType, ms.id)
  }

  const cycleName = `Меню недели ${monday.toLocaleDateString('ru-RU')}`

  // Создаём цикл с днями
  const cycle = await prisma.menuCycle.create({
    data: {
      name: cycleName,
      validFrom: monday,
      validTo: sunday,
      status: 'DRAFT',
      days: {
        create: [1, 2, 3, 4, 5, 6, 7].flatMap((dow) =>
          (['BREAKFAST', 'LUNCH', 'DINNER'] as MealType[]).map((mealType) => ({
            dayOfWeek: dow,
            mealType,
            mealSetId: mealSetByType.get(mealType),
          }))
        ),
      },
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_CREATED',
      entityType: 'MenuCycle',
      entityId: cycle.id,
      payload: { name: cycle.name, weekStart: monday.toISOString() },
    },
  })

  revalidatePath('/menu')
  return { ok: true, data: { id: cycle.id } }
}

/**
 * Сохраняет блюда для конкретного дня (полностью пересоздаёт MenuDayDish для этого дня и meal type).
 */
const saveDayDishesSchema = z.object({
  menuDayId: z.string(),
  dishes: z.array(z.object({
    dishId: z.string(),
    slotCategory: z.enum([
      'SOUP', 'MAIN', 'GARNISH', 'SALAD', 'DESSERT', 'DRINK',
      'BREAD_WHITE', 'BREAD_DARK', 'PORRIDGE', 'EGGS', 'PANCAKE', 'OTHER',
    ]),
  })),
})

export async function saveDayDishes(
  menuDayId: string,
  dishes: Array<{ dishId: string; slotCategory: DishCategory }>
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'CHEF'])

  const parsed = saveDayDishesSchema.safeParse({ menuDayId, dishes })
  if (!parsed.success) {
    return { ok: false, error: 'Неверные данные' }
  }

  // Проверим что меню в DRAFT (нельзя редактировать утверждённое)
  const menuDay = await prisma.menuDay.findUnique({
    where: { id: menuDayId },
    include: { menuCycle: true },
  })

  if (!menuDay) {
    return { ok: false, error: 'День меню не найден' }
  }

  if (menuDay.menuCycle.status !== 'DRAFT') {
    return { ok: false, error: 'Можно редактировать только черновик' }
  }

  // Транзакция: удалить старые, создать новые
  await prisma.$transaction([
    prisma.menuDayDish.deleteMany({ where: { menuDayId } }),
    ...parsed.data.dishes.map((d) =>
      prisma.menuDayDish.create({
        data: {
          menuDayId,
          dishId: d.dishId,
          slotCategory: d.slotCategory,
        },
      })
    ),
  ])

  revalidatePath('/menu')
  return { ok: true, data: undefined }
}

/**
 * Утверждает меню. Только ADMIN.
 */
export async function approveMenu(cycleId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const cycle = await prisma.menuCycle.findUnique({ where: { id: cycleId } })
  if (!cycle) {
    return { ok: false, error: 'Меню не найдено' }
  }
  if (cycle.status !== 'DRAFT') {
    return { ok: false, error: 'Утвердить можно только черновик' }
  }

  // Проверяем что в меню есть хотя бы одно блюдо
  const dishCount = await prisma.menuDayDish.count({
    where: {
      menuDay: {
        menuCycleId: cycleId,
      },
    },
  })
  if (dishCount === 0) {
    return { ok: false, error: 'Нельзя утвердить пустое меню. Добавьте блюда хотя бы в один день.' }
  }

  await prisma.menuCycle.update({
    where: { id: cycleId },
    data: {
      status: 'APPROVED',
      approvedById: user.id,
      approvedAt: new Date(),
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_APPROVED',
      entityType: 'MenuCycle',
      entityId: cycleId,
      payload: { name: cycle.name },
    },
  })

  revalidatePath('/menu')
  return { ok: true, data: undefined }
}

/**
 * Отзывает утверждение меню — APPROVED → DRAFT. Только ADMIN.
 */
export async function unapproveMenu(cycleId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const cycle = await prisma.menuCycle.findUnique({ where: { id: cycleId } })
  if (!cycle) {
    return { ok: false, error: 'Меню не найдено' }
  }
  if (cycle.status !== 'APPROVED') {
    return { ok: false, error: 'Отозвать можно только утверждённое меню' }
  }

  await prisma.menuCycle.update({
    where: { id: cycleId },
    data: {
      status: 'DRAFT',
      approvedById: null,
      approvedAt: null,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_UNAPPROVED',
      entityType: 'MenuCycle',
      entityId: cycleId,
      payload: { name: cycle.name },
    },
  })

  revalidatePath('/menu')
  return { ok: true, data: undefined }
}

/**
 * Архивирует меню — APPROVED → ARCHIVED. Только ADMIN.
 */
export async function archiveMenu(cycleId: string): Promise<ActionResult> {
  await requireRole(['ADMIN'])

  await prisma.menuCycle.update({
    where: { id: cycleId },
    data: { status: 'ARCHIVED' },
  })

  revalidatePath('/menu')
  return { ok: true, data: undefined }
}
