'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { getMondayOfWeek, getSundayOfWeek } from '@/lib/utils/week'
import { formatDateMsk } from '@/lib/utils/format'
import {
  notifyAdminsAboutPendingMenu,
  notifyGroupAboutApprovedMenu,
  notifyChefsAboutRejectedMenu,
} from '@/lib/bot/notify-menu'
import type { DishCategory, MealType, MenuStatus } from '@prisma/client'

const createMenuSchema = z.object({
  weekStartIso: z.string(), // ISO date string понедельника недели
})

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// Узкий вариант для createDraftMenu: на коллизию возвращает importId, если за
// существующим циклом стоит preview AI-импорта (DRAFT/PENDING_APPROVAL).
export type CreateDraftMenuResult =
  | { ok: true; data: { id: string } }
  | { ok: false; error: string; importId?: string }

/**
 * Создаёт пустой черновик меню для заданной недели.
 * Сразу создаёт MenuDay для каждого из 7 дней × 3 типов питания (с привязкой к default MealSet).
 * Блюда — пусто, шеф наполняет позже.
 */
export async function createDraftMenu(weekStartIso: string): Promise<CreateDraftMenuResult> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = createMenuSchema.safeParse({ weekStartIso })
  if (!parsed.success) {
    return { ok: false, error: 'Неверная дата недели' }
  }

  const monday = getMondayOfWeek(new Date(parsed.data.weekStartIso))
  const sunday = getSundayOfWeek(monday)

  // 7.6 B.2/B.3: при коллизии — пытаемся вытащить ассоциированный MenuImport
  // через Dish.menuImportId (тот же канон что в expand-menu / page.tsx) и
  // вернуть его id, чтобы UI открыл правильный preview импорта.
  const existing = await prisma.menuCycle.findFirst({
    where: { validFrom: monday },
    select: {
      id: true,
      days: {
        orderBy: { dayOfWeek: 'asc' },
        take: 1,
        select: {
          dishes: {
            take: 1,
            select: {
              dish: {
                select: {
                  menuImport: { select: { id: true, status: true } },
                },
              },
            },
          },
        },
      },
    },
  })

  if (existing) {
    const imp = existing.days[0]?.dishes[0]?.dish?.menuImport
    if (imp && (imp.status === 'DRAFT' || imp.status === 'PENDING_APPROVAL')) {
      return {
        ok: false,
        error: 'На эту неделю уже есть preview AI-импорта. Откройте его в разделе «Импорт меню» и утвердите.',
        importId: imp.id,
      }
    }
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

  const cycleName = `Меню недели ${formatDateMsk(monday)}`

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

const SAVE_BLOCKED_REASON: Partial<Record<MenuStatus, string>> = {
  PENDING_APPROVAL:
    'Меню на согласовании. Сначала верните его в черновик или дождитесь решения администратора.',
  APPROVED: 'Меню утверждено. Снимите утверждение для редактирования.',
  ARCHIVED: 'Меню архивировано. Редактирование невозможно.',
}

export async function saveDayDishes(
  menuDayId: string,
  dishes: Array<{ dishId: string; slotCategory: DishCategory }>
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'CHEF'])

  const parsed = saveDayDishesSchema.safeParse({ menuDayId, dishes })
  if (!parsed.success) {
    return { ok: false, error: 'Неверные данные' }
  }

  // Проверим что меню в DRAFT (нельзя редактировать утверждённое / на согласовании)
  const menuDay = await prisma.menuDay.findUnique({
    where: { id: menuDayId },
    include: { menuCycle: true },
  })

  if (!menuDay) {
    return { ok: false, error: 'День меню не найден' }
  }

  if (menuDay.menuCycle.status !== 'DRAFT') {
    const reason = SAVE_BLOCKED_REASON[menuDay.menuCycle.status]
    return { ok: false, error: reason ?? 'Можно редактировать только черновик' }
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
 * Отправляет меню на согласование (DRAFT → PENDING_APPROVAL). CHEF или ADMIN.
 * Сбрасывает rejectionComment — это новая итерация.
 */
export async function submitMenuForApproval(cycleId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const cycle = await prisma.menuCycle.findUnique({
    where: { id: cycleId },
    include: { days: { include: { dishes: true } } },
  })
  if (!cycle) return { ok: false, error: 'Меню не найдено' }
  if (cycle.status !== 'DRAFT') {
    return { ok: false, error: 'Можно отправить на согласование только черновик' }
  }

  const dishCount = cycle.days.reduce((acc, d) => acc + d.dishes.length, 0)
  if (dishCount === 0) {
    return {
      ok: false,
      error: 'Нельзя отправить на согласование пустое меню. Добавьте хотя бы одно блюдо.',
    }
  }

  await prisma.$transaction([
    prisma.menuCycle.update({
      where: { id: cycleId },
      data: { status: 'PENDING_APPROVAL', rejectionComment: null },
    }),
    prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'MENU_SUBMITTED_FOR_APPROVAL',
        entityType: 'MenuCycle',
        entityId: cycleId,
        payload: { menuCycleId: cycleId, menuName: cycle.name },
      },
    }),
  ])

  revalidatePath('/menu')

  await notifyAdminsAboutPendingMenu({
    menuCycleId: cycleId,
    menuName: cycle.name,
    chefName: user.name,
  })

  return { ok: true, data: undefined }
}

/**
 * Утверждает меню (PENDING_APPROVAL → APPROVED). Только ADMIN.
 * Проверку «пустое меню» здесь не делаем — в PENDING_APPROVAL не попадает пустое.
 */
export async function approveMenu(cycleId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const cycle = await prisma.menuCycle.findUnique({ where: { id: cycleId } })
  if (!cycle) {
    return { ok: false, error: 'Меню не найдено' }
  }
  if (cycle.status !== 'PENDING_APPROVAL') {
    return { ok: false, error: 'Утвердить можно только меню на согласовании' }
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

  await notifyGroupAboutApprovedMenu({
    menuCycleId: cycleId,
    menuName: cycle.name,
  })

  return { ok: true, data: undefined }
}

const rejectMenuSchema = z.object({
  comment: z.string().trim().max(500, 'Комментарий слишком длинный (макс 500 символов)').optional(),
})

/**
 * Возвращает меню на доработку (PENDING_APPROVAL → DRAFT). Только ADMIN.
 * Опционально сохраняет комментарий шефу.
 */
export async function rejectMenu(
  cycleId: string,
  comment?: string
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const parsed = rejectMenuSchema.safeParse({ comment })
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]
    return { ok: false, error: firstError?.message ?? 'Неверный комментарий' }
  }
  const normalizedComment = parsed.data.comment && parsed.data.comment.length > 0
    ? parsed.data.comment
    : null

  const cycle = await prisma.menuCycle.findUnique({ where: { id: cycleId } })
  if (!cycle) return { ok: false, error: 'Меню не найдено' }
  if (cycle.status !== 'PENDING_APPROVAL') {
    return { ok: false, error: 'Вернуть на доработку можно только меню на согласовании' }
  }

  await prisma.$transaction([
    prisma.menuCycle.update({
      where: { id: cycleId },
      data: {
        status: 'DRAFT',
        rejectionComment: normalizedComment,
        approvedById: null,
        approvedAt: null,
      },
    }),
    prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'MENU_REJECTED',
        entityType: 'MenuCycle',
        entityId: cycleId,
        payload: { menuCycleId: cycleId, menuName: cycle.name, comment: normalizedComment },
      },
    }),
  ])

  revalidatePath('/menu')

  await notifyChefsAboutRejectedMenu({
    menuCycleId: cycleId,
    menuName: cycle.name,
    comment: normalizedComment,
  })

  return { ok: true, data: undefined }
}

/**
 * Отзывает утверждение меню (APPROVED → DRAFT). Только ADMIN.
 * rejectionComment сбрасываем — снимаемое утверждение != возврат с комментарием.
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
      rejectionComment: null,
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
 * Архивирует меню. Разрешено из DRAFT или APPROVED.
 * Из PENDING_APPROVAL — отказ (сначала ADMIN должен утвердить или вернуть).
 * Из ARCHIVED — идемпотентный отказ.
 */
export async function archiveMenu(cycleId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN'])

  const cycle = await prisma.menuCycle.findUnique({ where: { id: cycleId } })
  if (!cycle) return { ok: false, error: 'Меню не найдено' }
  if (cycle.status === 'PENDING_APPROVAL') {
    return {
      ok: false,
      error: 'Сначала утвердите или верните меню на доработку, прежде чем архивировать',
    }
  }
  if (cycle.status === 'ARCHIVED') {
    return { ok: false, error: 'Меню уже архивировано' }
  }

  const fromStatus = cycle.status

  await prisma.$transaction([
    prisma.menuCycle.update({
      where: { id: cycleId },
      data: { status: 'ARCHIVED' },
    }),
    prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'MENU_ARCHIVED',
        entityType: 'MenuCycle',
        entityId: cycleId,
        payload: { menuCycleId: cycleId, menuName: cycle.name, fromStatus },
      },
    }),
  ])

  revalidatePath('/menu')
  return { ok: true, data: undefined }
}
