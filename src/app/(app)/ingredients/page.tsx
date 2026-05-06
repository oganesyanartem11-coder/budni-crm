import { PageHeader } from '@/components/layout/page-header'
import { IngredientsTable } from './ingredients-table'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'

export default async function IngredientsPage() {
  await requireRole(['ADMIN', 'CHEF'])

  const ingredients = await prisma.ingredient.findMany({
    orderBy: { name: 'asc' },
    include: {
      priceHistory: {
        orderBy: { validFrom: 'desc' },
        take: 20,
      },
    },
  })

  // Decimal → number, чтобы передать в Client Component без warnings
  const serialized = serialize(ingredients)

  return (
    <>
      <PageHeader
        title="Сырьё"
        subtitle="Справочник ингредиентов и цен"
      />
      <IngredientsTable ingredients={serialized} />
    </>
  )
}
