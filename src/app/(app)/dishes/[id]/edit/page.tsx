import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { DishForm } from '../../dish-form'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { listActiveIngredientsLight } from '@/lib/db/queries/ingredients'
import { serialize } from '@/lib/utils/serialize'

export default async function EditDishPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const { id } = await params

  const dish = await prisma.dish.findUnique({
    where: { id },
    include: {
      ingredients: {
        include: { ingredient: true },
      },
    },
  })

  if (!dish || !dish.isActive) {
    notFound()
  }

  const ingredients = serialize(await listActiveIngredientsLight())
  const canSeePrices = user.role !== 'CHEF'

  // Defense-in-depth: для CHEF цены в техкарте зануляем.
  const safeIngredients = canSeePrices
    ? ingredients
    : ingredients.map((ing) => ({ ...ing, pricePerUnit: 0 }))
  const serializedDish = serialize(dish)
  const safeDish = canSeePrices
    ? serializedDish
    : {
        ...serializedDish,
        ingredients: serializedDish.ingredients.map((line) => ({
          ...line,
          ingredient: { ...line.ingredient, pricePerUnit: 0 },
        })),
      }

  return (
    <>
      <PageHeader
        title={dish.name}
        subtitle="Редактирование блюда и техкарты"
      />
      <DishForm dish={safeDish} ingredients={safeIngredients} canSeePrices={canSeePrices} />
    </>
  )
}
