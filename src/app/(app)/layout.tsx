import { Sidebar } from '@/components/layout/sidebar'
import { MobileNav } from '@/components/layout/mobile-nav'
import { getCurrentUser } from '@/lib/auth/current-user'
import { isAdminLike, isAdminPro } from '@/lib/auth/role-helpers'
import { countPendingConfirmationToday } from '@/lib/db/queries/orders'
import { getDraftIngredientsCount } from '@/lib/db/queries/sidebar-counts'
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

  const isAdminOrManager = isAdminLike(user.role) || user.role === 'MANAGER'
  const canSeeInvoices =
    isAdminLike(user.role) || user.role === 'MANAGER' || user.role === 'CHEF'

  const [pendingCount, inboxCount, invoicesPending, draftIngredientsCount] =
    await Promise.all([
      isAdminOrManager ? countPendingConfirmationToday() : Promise.resolve(0),
      isAdminOrManager
        ? prisma.botMessage.count({ where: { direction: 'IN', readAt: null } })
        : Promise.resolve(0),
      canSeeInvoices
        ? prisma.invoice.count({ where: { status: 'AWAITING_ACCEPT' } })
        : Promise.resolve(0),
      // DRAFT-ингредиенты утверждать может только ADMIN_PRO — не раздуваем
      // badge остальным ролям (они физически не могут пройти на страницу
      // /invoices/draft-ingredients и не должны видеть счётчик в сайдбаре).
      isAdminPro(user.role) ? getDraftIngredientsCount() : Promise.resolve(0),
    ])

  // Sidebar badge на пункте «Накладные» — сумма "требующих внимания админа":
  // ожидающие приёмки накладные + новые ингредиенты-черновики (только для PRO).
  const invoicesAwaitingCount = invoicesPending + draftIngredientsCount

  return (
    <div className="min-h-screen bg-bg flex">
      <Sidebar
        userRole={user.role}
        userName={user.name}
        initials={initials}
        pendingCount={pendingCount}
        inboxCount={inboxCount}
        invoicesAwaitingCount={invoicesAwaitingCount}
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
        invoicesAwaitingCount={invoicesAwaitingCount}
      />
    </div>
  )
}
