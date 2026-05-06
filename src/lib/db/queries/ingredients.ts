import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'

export async function listIngredients(opts?: { includeInactive?: boolean }) {
  return prisma.ingredient.findMany({
    where: opts?.includeInactive ? undefined : { isActive: true },
    orderBy: { name: 'asc' },
  })
}

export async function getIngredient(id: string) {
  return prisma.ingredient.findUnique({
    where: { id },
    include: {
      priceHistory: {
        orderBy: { validFrom: 'desc' },
        take: 20,
      },
    },
  })
}

export async function getIngredientPriceHistory(id: string) {
  return prisma.ingredientPriceHistory.findMany({
    where: { ingredientId: id },
    orderBy: { validFrom: 'desc' },
    take: 50,
  })
}

export async function listActiveIngredientsLight() {
  return prisma.ingredient.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      unit: true,
      pricePerUnit: true,
    },
  })
}
