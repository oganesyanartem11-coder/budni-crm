import { prisma } from '@/lib/db/prisma'

/** Количество DRAFT-ингредиентов, ждущих утверждения от ADMIN_PRO. */
export async function getDraftIngredientsCount(): Promise<number> {
  return prisma.ingredient.count({ where: { status: 'DRAFT' } })
}
