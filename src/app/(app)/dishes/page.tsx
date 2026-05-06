import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { DishesGrid } from './dishes-grid'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'

export default async function DishesPage() {
  const user = await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const dishes = await prisma.dish.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: {
      ingredients: {
        include: { ingredient: true },
        orderBy: { ingredient: { name: 'asc' } },
      },
    },
  })

  const serialized = serialize(dishes)
  const canEdit = user.role === 'ADMIN' || user.role === 'CHEF'

  return (
    <>
      <PageHeader
        title="Блюда"
        subtitle="Справочник блюд и техкарт"
        actions={
          canEdit ? (
            <Link
              href="/dishes/new"
              className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Добавить блюдо
            </Link>
          ) : undefined
        }
      />
      <DishesGrid dishes={serialized} canEdit={canEdit} />
    </>
  )
}
