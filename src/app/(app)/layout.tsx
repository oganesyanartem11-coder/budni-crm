import { Sidebar } from '@/components/layout/sidebar'
import { MobileNav } from '@/components/layout/mobile-nav'
import { getCurrentUser } from '@/lib/auth/current-user'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'
import { prisma } from '@/lib/db/prisma'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()
  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const isAdminOrManager = user.role === 'ADMIN' || user.role === 'MANAGER'
  const [pendingCount, inboxCount] = isAdminOrManager
    ? await Promise.all([
        countPendingConfirmationToday(),
        prisma.botMessage.count({ where: { direction: 'IN', readAt: null } }),
      ])
    : [0, 0]

  return (
    <div className="min-h-screen bg-bg flex">
      <Sidebar
        userRole={user.role}
        userName={user.name}
        initials={initials}
        pendingCount={pendingCount}
        inboxCount={inboxCount}
      />

      <main className="flex-1 min-w-0 px-4 lg:px-8 py-6 lg:py-10 pb-24 lg:pb-10">
        <div className="mx-auto w-full max-w-[var(--container-page)]">
          {children}
        </div>
      </main>

      <MobileNav
        userRole={user.role}
        userName={user.name}
        initials={initials}
        pendingCount={pendingCount}
        inboxCount={inboxCount}
      />
    </div>
  )
}
