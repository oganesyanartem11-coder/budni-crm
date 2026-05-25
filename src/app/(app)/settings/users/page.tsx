import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { prisma } from '@/lib/db/prisma'
import { UsersTable } from './users-table'

export default async function UsersPage() {
  const me = await requireRole(['ADMIN'])

  const now = new Date()
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      onboardedAt: true,
      telegramChatId: true,
      telegramUsername: true,
      loginLockedUntil: true,
      failedLoginAttempts: true,
      _count: {
        select: {
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: now } },
          },
        },
      },
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
          id: u.id,
          name: u.name,
          role: u.role,
          isActive: u.isActive,
          createdAt: u.createdAt.toISOString(),
          onboardedAt: u.onboardedAt ? u.onboardedAt.toISOString() : null,
          telegramChatId: u.telegramChatId,
          telegramUsername: u.telegramUsername,
          loginLockedUntil: u.loginLockedUntil
            ? u.loginLockedUntil.toISOString()
            : null,
          failedLoginAttempts: u.failedLoginAttempts,
          activeSessionsCount: u._count.sessions,
        }))}
        currentUserId={me.id}
      />
    </>
  )
}
