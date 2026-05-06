import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/layout/page-header'
import { DishForm } from '../../dish-form'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { listActiveIngredientsLight } from '@/lib/db/queries/ingredients'
import { serialize } from '@/lib/utils/serialize'

export default async function EditDishPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(['ADMIN', 'CHEF'])

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

  return (
    <>
      <PageHeader
        title={dish.name}
        subtitle="Редактирование блюда и техкарты"
      />
      <DishForm dish={serialize(dish)} ingredients={ingredients} />
    </>
  )
}
