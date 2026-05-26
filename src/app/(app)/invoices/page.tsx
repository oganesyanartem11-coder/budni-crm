import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { isAdminPro } from '@/lib/auth/role-helpers'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { getDraftIngredientsCount } from '@/lib/db/queries/sidebar-counts'
import { InvoicesList } from './invoices-list'
import type { InvoiceStatus, Prisma } from '@prisma/client'

const ALL_STATUS_VALUES: InvoiceStatus[] = [
  'PROCESSING',
  'AWAITING_ACCEPT',
  'ACCEPTED',
  'REJECTED',
  'REVERTED',
  'FAILED',
]

interface PageProps {
  searchParams: Promise<{ status?: string; supplier?: string; q?: string }>
}

function parseStatus(v: string | undefined): InvoiceStatus | undefined {
  if (!v) return undefined
  return (ALL_STATUS_VALUES as string[]).includes(v) ? (v as InvoiceStatus) : undefined
}

export default async function InvoicesPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'CHEF'])
  const params = await searchParams

  const status = parseStatus(params.status)
  const supplier = params.supplier?.trim() || undefined
  const q = params.q?.trim() || undefined

  const where: Prisma.InvoiceWhereInput = {}
  if (status) where.status = status
  if (supplier) where.supplierNameLower = { contains: supplier.toLowerCase() }
  if (q) {
    where.OR = [
      { supplierName: { contains: q, mode: 'insensitive' } },
      { invoiceNumber: { contains: q, mode: 'insensitive' } },
    ]
  }

  const [invoices, draftCount] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        supplierName: true,
        invoiceNumber: true,
        invoiceDate: true,
        receivedAt: true,
        status: true,
        progress: true,
        totalAmount: true,
        _count: { select: { lines: true } },
      },
    }),
    isAdminPro(user.role) ? getDraftIngredientsCount() : Promise.resolve(0),
  ])

  return (
    <>
      <PageHeader
        title="Накладные"
        actions={
          <Link
            href="/invoices/new"
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">Загрузить накладную</span>
          </Link>
        }
      />
      <InvoicesList
        invoices={serialize(invoices)}
        activeStatus={status}
        activeSupplier={supplier}
        activeQuery={q}
        draftIngredientsCount={draftCount}
      />
    </>
  )
}
