import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { UsersTable } from './users-table'

export default async function UsersPage() {
  const me = await requireRole(['ADMIN'])

  const users = await prisma.user.findMany({
    orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      maxChatId: true,
      onboardedAt: true,
    },
  })

  return (
    <>
      <div className="mb-6">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К настройкам
        </Link>
      </div>
      <PageHeader title="Пользователи" subtitle={`Всего: ${users.length}`} />
      <UsersTable
        users={users.map((u) => ({
          ...u,
          createdAt: u.createdAt.toISOString(),
          onboardedAt: u.onboardedAt ? u.onboardedAt.toISOString() : null,
        }))}
        currentUserId={me.id}
      />
    </>
  )
}
