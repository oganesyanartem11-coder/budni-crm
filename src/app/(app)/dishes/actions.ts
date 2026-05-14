'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import type { DishCategory, DishUnit } from '@prisma/client'

const ingredientLineSchema = z.object({
  ingredientId: z.string().min(1, 'Выберите ингредиент'),
  bruttoGrams: z.number().nonnegative('Брутто не может быть отрицательным'),
  nettoGrams: z.number().nonnegative('Нетто не может быть отрицательным'),
})

const dishSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(150),
  category: z.enum([
    'SOUP', 'MAIN', 'GARNISH', 'SALAD', 'DESSERT', 'DRINK',
    'BREAD_WHITE', 'BREAD_DARK', 'PORRIDGE', 'EGGS', 'PANCAKE', 'OTHER',
  ]),
  unit: z.enum(['PORTION', 'LITER', 'KG', 'PIECE']),
  portionSize: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  ingredients: z.array(ingredientLineSchema).min(1, 'Добавьте хотя бы один ингредиент'),
})

export type DishFormData = z.infer<typeof dishSchema>

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

export async function createDish(formData: DishFormData): Promise<ActionResult<{ id: string }>> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const parsed = dishSchema.safeParse(formData)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные формы',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    }
  }

  // Проверка дубликатов: блюдо с тем же именем И категорией не должно быть активным
  const conflict = await prisma.dish.findFirst({
    where: {
      name: parsed.data.name,
      category: parsed.data.category,
      isActive: true,
    },
  })
  if (conflict) {
    return { ok: false, error: 'Блюдо с таким названием уже существует в этой категории' }
  }

  const dish = await prisma.dish.create({
    data: {
      name: parsed.data.name,
      category: parsed.data.category,
      unit: parsed.data.unit,
      portionSize: parsed.data.portionSize ?? null,
      notes: parsed.data.notes ?? null,
      ingredients: {
        create: parsed.data.ingredients.map((line) => ({
          ingredientId: line.ingredientId,
          bruttoGrams: line.bruttoGrams,
          nettoGrams: line.nettoGrams,
        })),
      },
    },
  })

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_CREATED',
      entityType: 'Dish',
      entityId: dish.id,
      payload: { name: dish.name, ingredientsCount: parsed.data.ingredients.length },
    },
  })

  revalidatePath('/dishes')
  return { ok: true, data: { id: dish.id } }
}

export async function updateDish(id: string, formData: DishFormData): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const parsed = dishSchema.safeParse(formData)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Неверные данные формы',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    }
  }

  const current = await prisma.dish.findUnique({ where: { id } })
  if (!current) {
    return { ok: false, error: 'Блюдо не найдено' }
  }

  // Проверка дубликатов при смене имени
  if (current.name !== parsed.data.name || current.category !== parsed.data.category) {
    const conflict = await prisma.dish.findFirst({
      where: {
        name: parsed.data.name,
        category: parsed.data.category,
        isActive: true,
        NOT: { id },
      },
    })
    if (conflict) {
      return { ok: false, error: 'Блюдо с таким названием уже существует в этой категории' }
    }
  }

  // Транзакция: апдейтим блюдо и пересоздаём список ингредиентов
  await prisma.$transaction([
    prisma.dishIngredient.deleteMany({ where: { dishId: id } }),
    prisma.dish.update({
      where: { id },
      data: {
        name: parsed.data.name,
        category: parsed.data.category,
        unit: parsed.data.unit,
        portionSize: parsed.data.portionSize ?? null,
        notes: parsed.data.notes ?? null,
        ingredients: {
          create: parsed.data.ingredients.map((line) => ({
            ingredientId: line.ingredientId,
            bruttoGrams: line.bruttoGrams,
            nettoGrams: line.nettoGrams,
          })),
        },
      },
    }),
  ])

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_UPDATED',
      entityType: 'Dish',
      entityId: id,
      payload: { name: parsed.data.name },
    },
  })

  revalidatePath('/dishes')
  revalidatePath(`/dishes/${id}/edit`)
  return { ok: true, data: undefined }
}

/**
 * Возвращает информацию об использовании блюда в меню.
 * Используется для показа предупреждения перед удалением.
 */
export async function getDishUsage(id: string): Promise<{
  menuCount: number
  menus: Array<{ id: string; name: string; status: string }>
}> {
  await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const menuDayDishes = await prisma.menuDayDish.findMany({
    where: { dishId: id },
    include: {
      menuDay: {
        include: {
          menuCycle: {
            select: { id: true, name: true, status: true },
          },
        },
      },
    },
  })

  const uniqueMenus = new Map<string, { id: string; name: string; status: string }>()
  for (const mdd of menuDayDishes) {
    const cycle = mdd.menuDay.menuCycle
    if (!uniqueMenus.has(cycle.id)) {
      uniqueMenus.set(cycle.id, cycle)
    }
  }

  const menus = Array.from(uniqueMenus.values())
  return { menuCount: menus.length, menus }
}

export async function deleteDish(id: string, force = false): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const dish = await prisma.dish.findUnique({ where: { id } })
  if (!dish) {
    return { ok: false, error: 'Блюдо не найдено' }
  }

  // Проверка использования в меню
  const usage = await getDishUsage(id)
  if (usage.menuCount > 0 && !force) {
    return {
      ok: false,
      error: `Блюдо используется в ${usage.menuCount} меню. Подтвердите удаление.`,
    }
  }

  // Soft-delete: ставим isActive = false. Связь с Order не нарушаем.
  // Если есть menu_day_dishes — удаляем их (история заказов не пострадает,
  // потому что Order.id не ссылается на MenuDayDish).
  await prisma.$transaction([
    prisma.menuDayDish.deleteMany({ where: { dishId: id } }),
    prisma.dish.update({
      where: { id },
      data: { isActive: false },
    }),
  ])

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      userRole: user.role,
      action: 'DISH_DELETED',
      entityType: 'Dish',
      entityId: id,
      payload: { name: dish.name, force, menusAffected: usage.menuCount },
    },
  })

  revalidatePath('/dishes')
  return { ok: true, data: undefined }
}
