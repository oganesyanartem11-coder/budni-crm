'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { requireRole } from '@/lib/auth/current-user'
import { runMenuImportFromExcel } from '@/lib/menu-import/run-import'
import { rollbackMenuImport, type RollbackResult } from '@/lib/menu-import/assemble'
import {
  getMenuStructureFromImport,
  expandMenuFromStructure,
  isMonday,
} from '@/lib/menu-import/expand-menu'
import {
  notifyAdminsAboutPendingMenuImport,
  notifyChefAboutRejectedMenuImport,
} from '@/lib/bot/notify-import'
import type { MenuImportProgress } from '@prisma/client'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 МБ — разумный лимит для xlsx-меню

export async function createMenuImport(
  formData: FormData
): Promise<ActionResult<{ menuImportId: string }>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Файл не выбран' }
  }
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, error: 'Файл больше 10 МБ. Уменьшите или сожмите.' }
  }
  const lower = file.name.toLowerCase()
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
    return { ok: false, error: 'Поддерживаются только Excel-файлы (.xlsx, .xls). Фото-меню добавим позже.' }
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  // runMenuImportFromExcel создаёт MenuImport-плейсхолдер синхронно и возвращает id;
  // дальше пайплайн extract→parse→generate→assemble идёт fire-and-forget IIFE.
  // На Vercel serverless IIFE прервётся после ответа — оборачивание в next/server.after
  // оставим на этап интеграции с роутом (8.7), для пилота локально работает как есть.
  const { menuImportId } = await runMenuImportFromExcel({
    fileBuffer: buffer,
    userId: user.id,
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_IMPORT_STARTED',
      entityType: 'MenuImport',
      entityId: menuImportId,
      payload: { fileName: file.name, fileSize: file.size, source: 'EXCEL' },
    },
  })

  revalidatePath('/menu/imports')
  return { ok: true, data: { menuImportId } }
}

export async function getMenuImportProgress(menuImportId: string): Promise<
  ActionResult<{
    progress: MenuImportProgress
    reason: string | null
    errorMessage: string | null
    updatedAt: Date
  }>
> {
  await requireRole(['ADMIN', 'CHEF'])

  const mi = await prisma.menuImport.findUnique({
    where: { id: menuImportId },
    select: { progress: true, reason: true, errorMessage: true, updatedAt: true },
  })
  if (!mi) return { ok: false, error: 'Импорт не найден' }

  return {
    ok: true,
    data: {
      progress: mi.progress,
      reason: mi.reason,
      errorMessage: mi.errorMessage,
      updatedAt: mi.updatedAt,
    },
  }
}

// === 8.6d: правки импорта (только status === 'DRAFT') ===========================

const STATUS_LOCKED_MSG =
  'Импорт уже на утверждении или закрыт, правки недоступны.'

// Возвращает { menuImportId } если найден импорт в DRAFT, иначе текст ошибки.
async function loadDishInDraftImport(dishId: string): Promise<
  | { ok: true; menuImportId: string }
  | { ok: false; error: string }
> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    select: { menuImportId: true, menuImport: { select: { status: true } } },
  })
  if (!dish || !dish.menuImportId || !dish.menuImport) {
    return { ok: false, error: 'Блюдо не принадлежит активному импорту' }
  }
  if (dish.menuImport.status !== 'DRAFT') {
    return { ok: false, error: STATUS_LOCKED_MSG }
  }
  return { ok: true, menuImportId: dish.menuImportId }
}

async function assertImportDraft(menuImportId: string): Promise<ActionResult<void>> {
  const mi = await prisma.menuImport.findUnique({
    where: { id: menuImportId },
    select: { status: true },
  })
  if (!mi) return { ok: false, error: 'Импорт не найден' }
  if (mi.status !== 'DRAFT') return { ok: false, error: STATUS_LOCKED_MSG }
  return { ok: true, data: undefined }
}

const STATUS_NOT_PENDING_MSG =
  'Импорт не на согласовании, действие недоступно.'

async function assertImportPendingApproval(
  menuImportId: string
): Promise<ActionResult<void>> {
  const mi = await prisma.menuImport.findUnique({
    where: { id: menuImportId },
    select: { status: true },
  })
  if (!mi) return { ok: false, error: 'Импорт не найден' }
  if (mi.status !== 'PENDING_APPROVAL') {
    return { ok: false, error: STATUS_NOT_PENDING_MSG }
  }
  return { ok: true, data: undefined }
}

const ingredientLineSchema = z.object({
  ingredientId: z.string().min(1),
  nettoGrams: z.number().min(0).max(10000),
})
const updateIngredientsSchema = z.object({
  dishId: z.string().min(1),
  ingredients: z.array(ingredientLineSchema),
})

export async function updateDishIngredients(
  input: z.infer<typeof updateIngredientsSchema>
): Promise<ActionResult<void>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = updateIngredientsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Неверные данные', fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const check = await loadDishInDraftImport(parsed.data.dishId)
  if (!check.ok) return { ok: false, error: check.error }

  // Brutto=Netto=grams (Уровень A) — то же правило что в assemble 8.5b.
  await prismaDirect.$transaction(
    async (tx) => {
      await tx.dishIngredient.deleteMany({ where: { dishId: parsed.data.dishId } })
      if (parsed.data.ingredients.length > 0) {
        await tx.dishIngredient.createMany({
          data: parsed.data.ingredients.map((i) => ({
            dishId: parsed.data.dishId,
            ingredientId: i.ingredientId,
            bruttoGrams: i.nettoGrams,
            nettoGrams: i.nettoGrams,
          })),
        })
      }
    },
    { timeout: 15000 }
  )

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_INGREDIENTS_UPDATED',
      entityType: 'Dish',
      entityId: parsed.data.dishId,
      payload: { count: parsed.data.ingredients.length },
    },
  })

  revalidatePath(`/menu/imports/${check.menuImportId}`)
  return { ok: true, data: undefined }
}

const mergeSchema = z.object({
  keepId: z.string().min(1),
  removeId: z.string().min(1),
})

export async function mergeDishes(
  input: z.infer<typeof mergeSchema>
): Promise<ActionResult<{ menuDayDishesMoved: number }>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = mergeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Неверные данные' }
  if (parsed.data.keepId === parsed.data.removeId) {
    return { ok: false, error: 'Нельзя слить блюдо с самим собой' }
  }

  // Оба должны принадлежать одному импорту в статусе DRAFT.
  const [keep, remove] = await Promise.all([
    prisma.dish.findUnique({
      where: { id: parsed.data.keepId },
      select: { menuImportId: true, menuImport: { select: { status: true } } },
    }),
    prisma.dish.findUnique({
      where: { id: parsed.data.removeId },
      select: { menuImportId: true, menuImport: { select: { status: true } } },
    }),
  ])
  if (!keep || !remove) return { ok: false, error: 'Блюдо не найдено' }
  if (!keep.menuImportId || keep.menuImportId !== remove.menuImportId) {
    return { ok: false, error: 'Блюда из разных импортов — нельзя слить' }
  }
  if (keep.menuImport?.status !== 'DRAFT' || remove.menuImport?.status !== 'DRAFT') {
    return { ok: false, error: STATUS_LOCKED_MSG }
  }

  const result = await prismaDirect.$transaction(
    async (tx) => {
      // 1) Перенаправляем меню-связи с remove → keep. Если у keep уже есть связь
      //    в том же MenuDay — будет конфликт уникальности? У MenuDayDish уник-индекса
      //    по (menuDayId, dishId) НЕТ (только по @@index). Дублей допустимо.
      const moved = await tx.menuDayDish.updateMany({
        where: { dishId: parsed.data.removeId },
        data: { dishId: parsed.data.keepId },
      })
      // 2) Удаляем ингредиенты remove (его DishIngredient).
      await tx.dishIngredient.deleteMany({ where: { dishId: parsed.data.removeId } })
      // 3) Удаляем сам Dish remove.
      await tx.dish.delete({ where: { id: parsed.data.removeId } })
      // 4) Шеф принял решение по дублю — снимаем AI-флаг с keep.
      // (ActivityLog DISH_MERGED уже хранит историю — в самой Dish дублировать не надо.)
      await tx.dish.update({
        where: { id: parsed.data.keepId },
        data: { correctionLevel: 'none', correctionNote: '' },
      })
      return { menuDayDishesMoved: moved.count }
    },
    { timeout: 15000 }
  )

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_MERGED',
      entityType: 'Dish',
      entityId: parsed.data.keepId,
      payload: {
        keepId: parsed.data.keepId,
        removeId: parsed.data.removeId,
        menuDayDishesMoved: result.menuDayDishesMoved,
      },
    },
  })

  revalidatePath(`/menu/imports/${keep.menuImportId}`)
  return { ok: true, data: result }
}

const deleteDishSchema = z.object({ dishId: z.string().min(1) })

export async function deleteDishFromImport(
  input: z.infer<typeof deleteDishSchema>
): Promise<ActionResult<{ menuDayDishesRemoved: number }>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = deleteDishSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Неверные данные' }

  const check = await loadDishInDraftImport(parsed.data.dishId)
  if (!check.ok) return { ok: false, error: check.error }

  const result = await prismaDirect.$transaction(
    async (tx) => {
      const removed = await tx.menuDayDish.deleteMany({
        where: { dishId: parsed.data.dishId },
      })
      await tx.dishIngredient.deleteMany({ where: { dishId: parsed.data.dishId } })
      await tx.dish.delete({ where: { id: parsed.data.dishId } })
      return { menuDayDishesRemoved: removed.count }
    },
    { timeout: 15000 }
  )

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_REMOVED_FROM_IMPORT',
      entityType: 'Dish',
      entityId: parsed.data.dishId,
      payload: {
        menuDayDishesRemoved: result.menuDayDishesRemoved,
      },
    },
  })

  revalidatePath(`/menu/imports/${check.menuImportId}`)
  return { ok: true, data: result }
}

const rollbackSchema = z.object({ menuImportId: z.string().min(1) })

export async function rollbackEntireImport(
  input: z.infer<typeof rollbackSchema>
): Promise<ActionResult<RollbackResult>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = rollbackSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Неверные данные' }

  const draftCheck = await assertImportDraft(parsed.data.menuImportId)
  if (!draftCheck.ok) return draftCheck

  const result = await rollbackMenuImport(parsed.data.menuImportId)

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_IMPORT_ROLLED_BACK',
      entityType: 'MenuImport',
      entityId: parsed.data.menuImportId,
      payload: {
        dishesDeleted: result.dishesDeleted,
        cyclesDeleted: result.cyclesDeleted,
      },
    },
  })

  revalidatePath('/menu/imports')
  return { ok: true, data: result }
}

const submitSchema = z.object({ menuImportId: z.string().min(1) })

export async function submitImportForApproval(
  input: z.infer<typeof submitSchema>
): Promise<ActionResult<void>> {
  const user = await requireRole(['ADMIN', 'CHEF'])

  const parsed = submitSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Неверные данные' }

  const draftCheck = await assertImportDraft(parsed.data.menuImportId)
  if (!draftCheck.ok) return draftCheck

  const dishesCount = await prisma.dish.count({
    where: { menuImportId: parsed.data.menuImportId },
  })
  if (dishesCount === 0) {
    return { ok: false, error: 'Нет блюд для отправки на утверждение' }
  }

  await prisma.menuImport.update({
    where: { id: parsed.data.menuImportId },
    data: { status: 'PENDING_APPROVAL' },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_IMPORT_SUBMITTED_FOR_APPROVAL',
      entityType: 'MenuImport',
      entityId: parsed.data.menuImportId,
      payload: { dishesCount },
    },
  })

  revalidatePath('/menu/imports')
  revalidatePath(`/menu/imports/${parsed.data.menuImportId}`)

  const importInfo = await prisma.menuImport.findUnique({
    where: { id: parsed.data.menuImportId },
    select: {
      _count: { select: { dishes: true } },
      createdBy: { select: { name: true } },
    },
  })
  if (importInfo) {
    await notifyAdminsAboutPendingMenuImport({
      menuImportId: parsed.data.menuImportId,
      dishesCount: importInfo._count.dishes,
      chefName: importInfo.createdBy?.name ?? 'Неизвестно',
    })
  }

  return { ok: true, data: undefined }
}

// === 8.7a: approve / reject / count для PENDING_APPROVAL =======================

const APPROVE_WEEKS_AHEAD = 13

const approveSchema = z.object({
  menuImportId: z.string().min(1),
  startDate: z.string().min(1), // ISO 'YYYY-MM-DD'
})

export async function approveMenuImport(
  input: z.infer<typeof approveSchema>
): Promise<ActionResult<{ cyclesCreated: number }>> {
  const user = await requireRole(['ADMIN'])

  const parsed = approveSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const check = await assertImportPendingApproval(parsed.data.menuImportId)
  if (!check.ok) return check

  const startDate = new Date(parsed.data.startDate + 'T00:00:00.000Z')
  if (Number.isNaN(startDate.getTime())) {
    return { ok: false, error: 'Неверный формат даты (ожидается YYYY-MM-DD)' }
  }
  if (!isMonday(startDate)) {
    return { ok: false, error: 'Дата старта должна быть понедельником' }
  }

  let cyclesCreated: number
  try {
    cyclesCreated = await prismaDirect.$transaction(
      async (tx) => {
        const structure = await getMenuStructureFromImport(parsed.data.menuImportId, tx)
        if (structure.weekA.days.length === 0) {
          throw new Error('Нет данных для разворачивания')
        }

        // Сносим будущие циклы ЧУЖИХ импортов на этом или позже понедельнике —
        // MenuDay/MenuDayDish уйдут каскадно (Cascade на menuCycleId/menuDayId).
        // Циклы текущего импорта в обрезку не попадают (filter menuImportId != X);
        // их исходные оригинальные циклы остаются как «архивная история».
        await tx.menuCycle.deleteMany({
          where: {
            validFrom: { gte: startDate },
            menuImportId: { not: parsed.data.menuImportId },
          },
        })

        const created = await expandMenuFromStructure(
          structure,
          startDate,
          APPROVE_WEEKS_AHEAD,
          parsed.data.menuImportId,
          user.id,
          tx
        )

        await tx.menuImport.update({
          where: { id: parsed.data.menuImportId },
          data: {
            status: 'APPROVED',
            approvedById: user.id,
            approvedAt: new Date(),
            startDate,
            rejectionComment: null,
          },
        })

        return created
      },
      { timeout: 30000 }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_IMPORT_APPROVED',
      entityType: 'MenuImport',
      entityId: parsed.data.menuImportId,
      payload: {
        startDate: parsed.data.startDate,
        cyclesCreated,
        weeksAhead: APPROVE_WEEKS_AHEAD,
      },
    },
  })

  revalidatePath('/menu/imports')
  revalidatePath(`/menu/imports/${parsed.data.menuImportId}`)
  revalidatePath('/menu')

  return { ok: true, data: { cyclesCreated } }
}

const rejectSchema = z.object({
  menuImportId: z.string().min(1),
  comment: z.string().min(1).max(2000),
})

export async function rejectMenuImport(
  input: z.infer<typeof rejectSchema>
): Promise<ActionResult<void>> {
  const user = await requireRole(['ADMIN'])

  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const check = await assertImportPendingApproval(parsed.data.menuImportId)
  if (!check.ok) return check

  await prisma.menuImport.update({
    where: { id: parsed.data.menuImportId },
    data: {
      status: 'DRAFT',
      rejectionComment: parsed.data.comment,
      approvedById: null,
      approvedAt: null,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'MENU_IMPORT_REJECTED',
      entityType: 'MenuImport',
      entityId: parsed.data.menuImportId,
      payload: { comment: parsed.data.comment },
    },
  })

  revalidatePath('/menu/imports')
  revalidatePath(`/menu/imports/${parsed.data.menuImportId}`)
  revalidatePath('/menu')

  const importInfo = await prisma.menuImport.findUnique({
    where: { id: parsed.data.menuImportId },
    select: { createdById: true },
  })
  await notifyChefAboutRejectedMenuImport({
    menuImportId: parsed.data.menuImportId,
    chefId: importInfo?.createdById ?? null,
    comment: parsed.data.comment,
  })

  return { ok: true, data: undefined }
}

const countReplaceableSchema = z.object({
  menuImportId: z.string().min(1),
  startDate: z.string().min(1),
})

// Сколько MenuCycle будет удалено при approve(menuImportId, startDate).
// Не модифицирует БД — только count для UI-предупреждения «будет удалено N циклов».
// Считает циклы ЧУЖИХ импортов с validFrom >= startDate (как и сам deleteMany в approve).
export async function countReplaceableCycles(
  input: z.infer<typeof countReplaceableSchema>
): Promise<ActionResult<{ count: number }>> {
  await requireRole(['ADMIN'])

  const parsed = countReplaceableSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Неверные данные' }
  }
  const startDate = new Date(parsed.data.startDate + 'T00:00:00.000Z')
  if (Number.isNaN(startDate.getTime())) {
    return { ok: false, error: 'Неверный формат даты (ожидается YYYY-MM-DD)' }
  }

  const count = await prisma.menuCycle.count({
    where: {
      validFrom: { gte: startDate },
      menuImportId: { not: parsed.data.menuImportId },
    },
  })

  return { ok: true, data: { count } }
}
