import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { DraftIngredientsList } from './draft-ingredients-list'

export default async function DraftIngredientsPage() {
  await requireRole(['ADMIN_PRO']) // строго PRO

  const [drafts, approved] = await Promise.all([
    prisma.ingredient.findMany({
      where: { status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { dishIngredients: true } },
        invoiceLines: {
          orderBy: { invoice: { receivedAt: 'desc' } },
          take: 1,
          include: {
            invoice: {
              select: { id: true, supplierName: true, invoiceDate: true },
            },
          },
        },
      },
    }),
    prisma.ingredient.findMany({
      where: { status: 'APPROVED', isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, unit: true },
    }),
  ])

  return (
    <>
      <PageHeader
        title="Новые ингредиенты"
        subtitle={
          drafts.length === 0
            ? 'Все ингредиенты утверждены'
            : `${drafts.length} на утверждение`
        }
        actions={
          <Link
            href="/invoices"
            className="px-4 py-2 rounded-pill border border-border text-fg text-sm hover:bg-fg/5 transition-colors flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            К накладным
          </Link>
        }
      />
      <DraftIngredientsList drafts={serialize(drafts)} approved={approved} />
    </>
  )
}
