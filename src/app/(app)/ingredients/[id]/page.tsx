import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { IngredientCard } from './ingredient-card'

export default async function IngredientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])
  const { id } = await params

  const ingredient = await prisma.ingredient.findUnique({
    where: { id },
    include: {
      priceHistory: { orderBy: { validFrom: 'desc' } },
    },
  })

  if (!ingredient) notFound()

  const serialized = serialize(ingredient)
  const canSeePrices = user.role !== 'CHEF'

  const safeIngredient = canSeePrices
    ? serialized
    : { ...serialized, pricePerUnit: 0, priceHistory: [] }

  return <IngredientCard ingredient={safeIngredient} canSeePrices={canSeePrices} />
}
