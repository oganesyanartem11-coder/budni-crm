import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { serialize } from '@/lib/utils/serialize'
import { ImportsList } from './imports-list'

export default async function MenuImportsPage() {
  await requireRole(['ADMIN', 'CHEF'])

  const imports = await prisma.menuImport.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      createdBy: { select: { name: true } },
      _count: { select: { dishes: true } },
    },
  })

  const serialized = serialize(imports)

  return (
    <>
      <PageHeader
        title="Импорт меню"
        subtitle="История AI-импортов меню из Excel"
        actions={
          <Link
            href="/menu/imports/new"
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            Новый импорт
          </Link>
        }
      />
      <ImportsList imports={serialized} />
    </>
  )
}
