'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { prismaDirect } from '@/lib/db/prisma-direct'
import { requireRole } from '@/lib/auth/current-user'

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Утвердить DRAFT-ингредиент как самостоятельный (status → APPROVED).
 */
export async function approveDraftIngredient(ingredientId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])
  const ing = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
    select: { id: true, status: true, name: true },
  })
  if (!ing) return { ok: false, error: 'Ингредиент не найден' }
  if (ing.status !== 'DRAFT') {
    return { ok: false, error: `Ингредиент в статусе ${ing.status}, ожидался DRAFT` }
  }

  await prisma.$transaction([
    prisma.ingredient.update({ where: { id: ingredientId }, data: { status: 'APPROVED' } }),
    prisma.activityLog.create({
      data: {
        userId: user.id,
        userRole: user.role,
        action: 'INGREDIENT_DRAFT_APPROVED',
        entityType: 'Ingredient',
        entityId: ingredientId,
        payload: { name: ing.name },
      },
    }),
  ])

  revalidatePath('/invoices/draft-ingredients')
  revalidatePath('/invoices')
  return { ok: true, data: undefined }
}

/**
 * Объединить DRAFT с существующим APPROVED. Все InvoiceLine FK переносятся,
 * brandVariants мерджатся (dedup by rawName), DRAFT удаляется hard.
 */
export async function mergeDraftIngredient(input: {
  draftId: string
  targetId: string
}): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])
  if (input.draftId === input.targetId) {
    return { ok: false, error: 'Нельзя объединить ингредиент с самим собой' }
  }

  const [draft, target] = await Promise.all([
    prisma.ingredient.findUnique({ where: { id: input.draftId } }),
    prisma.ingredient.findUnique({ where: { id: input.targetId } }),
  ])
  if (!draft) return { ok: false, error: 'DRAFT-ингредиент не найден' }
  if (!target) return { ok: false, error: 'Целевой ингредиент не найден' }
  if (draft.status !== 'DRAFT') {
    return { ok: false, error: `DRAFT-ингредиент в статусе ${draft.status}` }
  }
  if (target.status !== 'APPROVED') {
    return { ok: false, error: `Цель в статусе ${target.status}, ожидался APPROVED` }
  }

  type BrandVariant = { rawName?: string; lastSeenPrice?: number; lastSeenDate?: string }
  const draftVariants = Array.isArray(draft.brandVariants)
    ? (draft.brandVariants as BrandVariant[])
    : []
  const targetVariants = Array.isArray(target.brandVariants)
    ? (target.brandVariants as BrandVariant[])
    : []
  const merged: BrandVariant[] = [...targetVariants]
  for (const dv of draftVariants) {
    if (!dv?.rawName) continue
    if (!merged.some((tv) => tv?.rawName?.toLowerCase() === dv.rawName!.toLowerCase())) {
      merged.push(dv)
    }
  }

  try {
    await prismaDirect.$transaction(async (tx) => {
      // 1. Переносим FK у InvoiceLine
      await tx.invoiceLine.updateMany({
        where: { matchedIngredientId: input.draftId },
        data: { matchedIngredientId: input.targetId },
      })
      // 2. Переносим FK у DishIngredient (defense-in-depth, на DRAFT обычно нет)
      await tx.dishIngredient.updateMany({
        where: { ingredientId: input.draftId },
        data: { ingredientId: input.targetId },
      })
      // 3. Обновляем brandVariants у target
      await tx.ingredient.update({
        where: { id: input.targetId },
        data: { brandVariants: merged },
      })
      // 4. Удаляем priceHistory draft'а, потом сам ingredient.
      await tx.ingredientPriceHistory.deleteMany({
        where: { ingredientId: input.draftId },
      })
      await tx.ingredient.delete({ where: { id: input.draftId } })

      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'INGREDIENT_DRAFT_MERGED',
          entityType: 'Ingredient',
          entityId: input.targetId,
          payload: {
            draftId: input.draftId,
            targetId: input.targetId,
            draftName: draft.name,
            targetName: target.name,
          },
        },
      })
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  revalidatePath('/invoices/draft-ingredients')
  revalidatePath('/invoices')
  return { ok: true, data: undefined }
}

/**
 * Удалить DRAFT-ингредиент. Перед удалением проверяем что он НЕ используется
 * в техкартах (DishIngredient). InvoiceLine.matchedIngredientId зануляется +
 * matchedAction → 'SKIPPED' (история накладных остаётся).
 */
export async function deleteDraftIngredient(ingredientId: string): Promise<ActionResult> {
  const user = await requireRole(['ADMIN_PRO'])

  const ing = await prisma.ingredient.findUnique({
    where: { id: ingredientId },
    select: {
      id: true,
      status: true,
      name: true,
      _count: { select: { dishIngredients: true } },
    },
  })
  if (!ing) return { ok: false, error: 'Ингредиент не найден' }
  if (ing.status !== 'DRAFT') {
    return { ok: false, error: `Ингредиент в статусе ${ing.status}, ожидался DRAFT` }
  }
  if (ing._count.dishIngredients > 0) {
    return { ok: false, error: 'Ингредиент используется в техкартах — удаление невозможно' }
  }

  try {
    await prismaDirect.$transaction(async (tx) => {
      // Очищаем InvoiceLine — оставляем historic record, но action → SKIPPED
      await tx.invoiceLine.updateMany({
        where: { matchedIngredientId: ingredientId },
        data: { matchedIngredientId: null, matchedAction: 'SKIPPED' },
      })
      await tx.ingredientPriceHistory.deleteMany({ where: { ingredientId } })
      await tx.ingredient.delete({ where: { id: ingredientId } })

      await tx.activityLog.create({
        data: {
          userId: user.id,
          userRole: user.role,
          action: 'INGREDIENT_DRAFT_DELETED',
          entityType: 'Ingredient',
          entityId: ingredientId,
          payload: { name: ing.name },
        },
      })
    })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  revalidatePath('/invoices/draft-ingredients')
  return { ok: true, data: undefined }
}
