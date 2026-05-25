'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
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
