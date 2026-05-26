import { PageHeader } from '@/components/layout/page-header'
import { IngredientsTable } from './ingredients-table'
import { requireRole } from '@/lib/auth/current-user'
import { isAdminLike, isAdminPro } from '@/lib/auth/role-helpers'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'

export default async function IngredientsPage() {
  const user = await requireRole(['ADMIN', 'MANAGER', 'CHEF'])

  const ingredients = await prisma.ingredient.findMany({
    orderBy: { name: 'asc' },
    include: {
      priceHistory: {
        orderBy: { validFrom: 'desc' },
        take: 20,
      },
      _count: {
        select: {
          dishIngredients: true,
          invoiceLines: true,
        },
      },
    },
  })

  // Decimal → number, чтобы передать в Client Component без warnings
  const serialized = serialize(ingredients)
  const canSeePrices = user.role !== 'CHEF'
  const canEdit = isAdminLike(user.role) || user.role === 'MANAGER' || user.role === 'CHEF'
  // Bulk-операции (merge/delete) доступны ТОЛЬКО ADMIN_PRO — defense-in-depth
  // дополнительно к requireRole(['ADMIN_PRO']) на серверных actions.
  const isProAdmin = isAdminPro(user.role)

  // Defense-in-depth: даже если UI забудет скрыть цены — для CHEF поля занулены.
  const safeIngredients = canSeePrices
    ? serialized
    : serialized.map((ing) => ({ ...ing, pricePerUnit: 0, priceHistory: [] }))

  return (
    <>
      <PageHeader
        title="Сырьё"
        subtitle="Справочник ингредиентов и цен"
      />
      <IngredientsTable
        ingredients={safeIngredients}
        canSeePrices={canSeePrices}
        canEdit={canEdit}
        isAdminPro={isProAdmin}
      />
    </>
  )
}
