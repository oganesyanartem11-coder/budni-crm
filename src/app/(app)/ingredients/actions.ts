'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { requireRole } from '@/lib/auth/current-user'

const ingredientSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(100, 'Слишком длинное название'),
  unit: z.enum(['KG', 'L', 'PCS']),
  pricePerUnit: z.number().nonnegative('Цена не может быть отрицательной'),
  notes: z.string().max(500).optional().nullable(),
})

export type IngredientFormData = z.infer<typeof ingredientSchema>

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

export async function createIngredient(formData: IngredientFormData): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const parsed = ingredientSchema.safeParse(formData)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные формы',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  // Defense-in-depth: CHEF не должен задавать цены, всегда 0 на сервере
  // даже если что-то пришло из формы. Финансы — ответственность MANAGER+.
  const finalPrice = user.role === 'CHEF' ? 0 : parsed.data.pricePerUnit

  // J-1 (Sprint 7.11): notes — финансово-чувствительное поле (часто содержит
  // комментарии о поставщиках/ценах), CHEF не должен его задавать.
  const isChef = user.role === 'CHEF'
  const finalNotes = isChef ? undefined : (parsed.data.notes ?? undefined)

  // Уникальность по имени
  const existing = await prisma.ingredient.findUnique({
    where: { name: parsed.data.name },
  })
  if (existing) {
    return { ok: false, error: 'Ингредиент с таким названием уже существует' }
  }

  const ingredient = await prisma.ingredient.create({
    data: {
      name: parsed.data.name,
      unit: parsed.data.unit,
      pricePerUnit: finalPrice,
      notes: finalNotes,
    },
  })

  // Записываем первую запись в истории цен
  await prisma.ingredientPriceHistory.create({
    data: {
      ingredientId: ingredient.id,
      price: finalPrice,
      changedBy: user.id,
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'INGREDIENT_CREATED',
      entityType: 'Ingredient',
      entityId: ingredient.id,
      payload: { name: ingredient.name, price: finalPrice },
    },
  })

  revalidatePath('/ingredients')
  return { ok: true, data: undefined }
}

export async function updateIngredient(id: string, formData: IngredientFormData): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const parsed = ingredientSchema.safeParse(formData)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные формы',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const current = await prisma.ingredient.findUnique({ where: { id } })
  if (!current) {
    return { ok: false, error: 'Ингредиент не найден' }
  }

  // Проверка уникальности при смене имени
  if (current.name !== parsed.data.name) {
    const conflict = await prisma.ingredient.findUnique({
      where: { name: parsed.data.name },
    })
    if (conflict && conflict.id !== id) {
      return { ok: false, error: 'Ингредиент с таким названием уже существует' }
    }
  }

  // Defense-in-depth: CHEF не меняет цену — сохраняем текущее значение из БД,
  // игнорируя что пришло из формы. MANAGER/ADMIN — берём из формы.
  const isChef = user.role === 'CHEF'
  const effectivePrice = isChef ? Number(current.pricePerUnit) : parsed.data.pricePerUnit
  const priceChanged = !isChef && Number(current.pricePerUnit) !== parsed.data.pricePerUnit

  // J-1 (Sprint 7.11): notes — финансово-чувствительное (комментарии о поставщиках,
  // ценах, скидках). CHEF не редактирует — сохраняем текущее значение из БД.
  const effectiveNotes = isChef ? current.notes : (parsed.data.notes ?? null)

  await prisma.ingredient.update({
    where: { id },
    data: {
      name: parsed.data.name,
      unit: parsed.data.unit,
      pricePerUnit: effectivePrice,
      notes: effectiveNotes,
    },
  })

  // Если цена изменилась — пишем в историю (только не-CHEF может)
  if (priceChanged) {
    await prisma.ingredientPriceHistory.create({
      data: {
        ingredientId: id,
        price: parsed.data.pricePerUnit,
        changedBy: user.id,
      },
    })

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'INGREDIENT_PRICE_CHANGED',
        entityType: 'Ingredient',
        entityId: id,
        payload: {
          name: parsed.data.name,
          oldPrice: Number(current.pricePerUnit),
          newPrice: parsed.data.pricePerUnit,
        },
      },
    })
  }

  revalidatePath('/ingredients')
  return { ok: true, data: undefined }
}

// ============================================================
// BULK-операции (Sprint 7.MEGA-CLEANUP, БЛОК B)
// Доступны ТОЛЬКО ADMIN_PRO. Обычный ADMIN не может вызвать.
// ============================================================

type BrandVariant = {
  rawName?: string
  variant?: string
  supplier?: string
  seenAt?: string
  lastSeenPrice?: number
  lastSeenDate?: string
}

function mergeBrandVariantsList(lists: (unknown[] | null | undefined)[]): BrandVariant[] {
  const result: BrandVariant[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list as BrandVariant[]) {
      if (!item) continue
      const key = (item.rawName ?? item.variant ?? '').toLowerCase().trim()
      if (!key) {
        // Без ключа — добавляем без дедупа (не должно случаться, но defensive)
        result.push(item)
        continue
      }
      if (seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
  }
  return result
}

/**
 * Объединить несколько APPROVED-ингредиентов в один. sourceIds → targetId.
 *
 * Конфликт-резолюция для @@unique([dishId, ingredientId]):
 * source-DishIngredient'ы, у которых dishId уже есть у target, УДАЛЯЮТСЯ
 * (приоритет за target — у него уже есть запись с brutto/netto на это блюдо).
 * Остальные source-DishIngredient'ы перевешиваются на target.
 *
 * InvoiceLine.matchedIngredientId переносятся все — у InvoiceLine нет unique
 * по (invoice, ingredient), конфликтов не будет.
 */
export async function mergeIngredients(
  targetId: string,
  sourceIds: string[]
): Promise<ActionResult<{ mergedCount: number }>> {
  const user = await requireRole(['ADMIN_PRO'])

  // Guards
  if (!Array.isArray(sourceIds) || sourceIds.length < 1) {
    return { ok: false, error: 'Не выбрано ни одного исходного ингредиента' }
  }
  if (sourceIds.includes(targetId)) {
    return { ok: false, error: 'Целевой ингредиент не может быть в списке источников' }
  }
  // Дедуп sourceIds на всякий случай
  const uniqueSourceIds = Array.from(new Set(sourceIds))

  const allIds = [targetId, ...uniqueSourceIds]
  const ingredients = await prisma.ingredient.findMany({
    where: { id: { in: allIds } },
    select: { id: true, name: true, status: true, brandVariants: true },
  })

  if (ingredients.length !== allIds.length) {
    return { ok: false, error: 'Один или несколько ингредиентов не найдены' }
  }

  const notApproved = ingredients.filter((i) => i.status !== 'APPROVED')
  if (notApproved.length > 0) {
    return {
      ok: false,
      error: `Все ингредиенты должны быть в статусе APPROVED. Не APPROVED: ${notApproved.map((i) => i.name).join(', ')}`,
    }
  }

  const target = ingredients.find((i) => i.id === targetId)!
  const sources = ingredients.filter((i) => i.id !== targetId)

  try {
    await prismaDirect.$transaction(async (tx) => {
      // 1. Прочитать существующие DishIngredient у target (чтобы знать какие dishId уже занятые)
      const targetDishLinks = await tx.dishIngredient.findMany({
        where: { ingredientId: targetId },
        select: { dishId: true },
      })
      const existingDishIds = new Set(targetDishLinks.map((d) => d.dishId))

      // 2. Прочитать все DishIngredient у source
      const sourceDishLinks = await tx.dishIngredient.findMany({
        where: { ingredientId: { in: uniqueSourceIds } },
        select: { id: true, dishId: true },
      })

      // 3. Разделить на конфликты (target уже имеет это блюдо → удалить source) и переносимые
      const conflictIds: string[] = []
      const migratableIds: string[] = []
      for (const link of sourceDishLinks) {
        if (existingDishIds.has(link.dishId)) {
          conflictIds.push(link.id)
        } else {
          migratableIds.push(link.id)
        }
      }

      // 4. Удалить конфликтные source-записи (у target уже есть свой brutto/netto на это блюдо)
      if (conflictIds.length > 0) {
        await tx.dishIngredient.deleteMany({
          where: { id: { in: conflictIds } },
        })
      }

      // 5. Перевесить остальные source-DishIngredient на target
      if (migratableIds.length > 0) {
        await tx.dishIngredient.updateMany({
          where: { id: { in: migratableIds } },
          data: { ingredientId: targetId },
        })
      }

      // 6. Перенести InvoiceLine FK
      await tx.invoiceLine.updateMany({
        where: { matchedIngredientId: { in: uniqueSourceIds } },
        data: { matchedIngredientId: targetId },
      })

      // 7. Удалить историю цен source'ов (история target остаётся как primary)
      await tx.ingredientPriceHistory.deleteMany({
        where: { ingredientId: { in: uniqueSourceIds } },
      })

      // 8. Смерджить brandVariants
      const mergedVariants = mergeBrandVariantsList([
        target.brandVariants as unknown[] | null,
        ...sources.map((s) => s.brandVariants as unknown[] | null),
      ])
      await tx.ingredient.update({
        where: { id: targetId },
        data: {
          brandVariants:
            mergedVariants.length > 0
              ? (mergedVariants as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      })

      // 9. Удалить source-ингредиенты (FK уже расцеплены)
      await tx.ingredient.deleteMany({
        where: { id: { in: uniqueSourceIds } },
      })

      // 10. Активити-лог
      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'INGREDIENT_BULK_MERGED',
          entityType: 'Ingredient',
          entityId: targetId,
          payload: {
            targetId,
            targetName: target.name,
            sourceIds: uniqueSourceIds,
            sourceNames: sources.map((s) => s.name),
            mergedCount: uniqueSourceIds.length,
            conflictsResolved: conflictIds.length,
            dishIngredientsMigrated: migratableIds.length,
          },
        },
      })
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  revalidatePath('/ingredients')
  return { ok: true, data: { mergedCount: uniqueSourceIds.length } }
}

/**
 * Удалить несколько APPROVED-ингредиентов. Жёсткая проверка связей:
 * нельзя удалить ингредиент с активными DishIngredient или InvoiceLine.
 * Если хоть один имеет связи — отказ операции целиком (без частичного успеха).
 */
export async function bulkDeleteIngredients(
  ids: string[]
): Promise<ActionResult<{ deletedCount: number }>> {
  const user = await requireRole(['ADMIN_PRO'])

  if (!Array.isArray(ids) || ids.length < 1) {
    return { ok: false, error: 'Не выбрано ни одного ингредиента' }
  }
  const uniqueIds = Array.from(new Set(ids))

  const ingredients = await prisma.ingredient.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      name: true,
      status: true,
      _count: { select: { dishIngredients: true, invoiceLines: true } },
    },
  })

  if (ingredients.length !== uniqueIds.length) {
    return { ok: false, error: 'Один или несколько ингредиентов не найдены' }
  }

  const notApproved = ingredients.filter((i) => i.status !== 'APPROVED')
  if (notApproved.length > 0) {
    return {
      ok: false,
      error: `Все ингредиенты должны быть в статусе APPROVED. Не APPROVED: ${notApproved.map((i) => i.name).join(', ')}`,
    }
  }

  const withLinks = ingredients.filter(
    (i) => i._count.dishIngredients > 0 || i._count.invoiceLines > 0
  )
  if (withLinks.length > 0) {
    return {
      ok: false,
      error: `Нельзя удалить ${withLinks.length} ингредиент(ов) со связями. Сначала очистите DishIngredient/InvoiceLine: ${withLinks.map((i) => i.name).join(', ')}`,
    }
  }

  try {
    await prismaDirect.$transaction(async (tx) => {
      await tx.ingredientPriceHistory.deleteMany({
        where: { ingredientId: { in: uniqueIds } },
      })
      // Defense-in-depth: повторно фильтруем по status='APPROVED' на случай,
      // если за время между findMany и transaction статус подменили.
      await tx.ingredient.deleteMany({
        where: { id: { in: uniqueIds }, status: 'APPROVED' },
      })
      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'INGREDIENT_BULK_DELETED',
          entityType: 'Ingredient',
          payload: {
            ids: uniqueIds,
            names: ingredients.map((i) => i.name),
            count: uniqueIds.length,
          },
        },
      })
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  revalidatePath('/ingredients')
  return { ok: true, data: { deletedCount: uniqueIds.length } }
}

/**
 * Превью merge-операции: показывает сколько DishIngredient переедет,
 * сколько конфликтов разрешится удалением, сколько InvoiceLine перенесётся,
 * сколько priceHistory удалится. Read-only, не меняет данные.
 */
export async function getMergePreview(
  targetId: string,
  sourceIds: string[]
): Promise<
  ActionResult<{
    dishIngredientsToMigrate: number
    dishIngredientsToDelete: number
    invoiceLinesToMigrate: number
    priceHistoryToDelete: number
  }>
> {
  await requireRole(['ADMIN_PRO'])

  if (!Array.isArray(sourceIds) || sourceIds.length < 1) {
    return { ok: false, error: 'Не выбрано ни одного исходного ингредиента' }
  }
  if (sourceIds.includes(targetId)) {
    return { ok: false, error: 'Целевой ингредиент не может быть в списке источников' }
  }
  const uniqueSourceIds = Array.from(new Set(sourceIds))

  const targetDishLinks = await prisma.dishIngredient.findMany({
    where: { ingredientId: targetId },
    select: { dishId: true },
  })
  const existingDishIds = new Set(targetDishLinks.map((d) => d.dishId))

  const sourceDishLinks = await prisma.dishIngredient.findMany({
    where: { ingredientId: { in: uniqueSourceIds } },
    select: { dishId: true },
  })

  let dishIngredientsToDelete = 0
  let dishIngredientsToMigrate = 0
  for (const link of sourceDishLinks) {
    if (existingDishIds.has(link.dishId)) {
      dishIngredientsToDelete++
    } else {
      dishIngredientsToMigrate++
    }
  }

  const [invoiceLinesToMigrate, priceHistoryToDelete] = await Promise.all([
    prisma.invoiceLine.count({ where: { matchedIngredientId: { in: uniqueSourceIds } } }),
    prisma.ingredientPriceHistory.count({ where: { ingredientId: { in: uniqueSourceIds } } }),
  ])

  return {
    ok: true,
    data: {
      dishIngredientsToMigrate,
      dishIngredientsToDelete,
      invoiceLinesToMigrate,
      priceHistoryToDelete,
    },
  }
}

export async function archiveIngredient(id: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const current = await prisma.ingredient.findUnique({ where: { id } })
  if (!current) {
    return { ok: false, error: 'Ингредиент не найден' }
  }

  await prisma.ingredient.update({
    where: { id },
    data: { isActive: !current.isActive },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: current.isActive ? 'INGREDIENT_ARCHIVED' : 'INGREDIENT_RESTORED',
      entityType: 'Ingredient',
      entityId: id,
      payload: { name: current.name },
    },
  })

  revalidatePath('/ingredients')
  return { ok: true, data: undefined }
}
