'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MOBILE_TABBAR_BY_ROLE, type NavBadgeKey } from '@/lib/navigation'
import { cn } from '@/lib/utils/cn'
import type { UserRole } from '@prisma/client'

interface Props {
  userRole: UserRole
  // userName/initials больше не используются в таббаре (drawer/ProfileMenu удалён),
  // но API пропсов сохранён, чтобы не ломать вызов из (app)/layout.tsx.
  userName: string
  initials: string
  pendingCount: number
  inboxCount: number
  invoicesAwaitingCount: number
}

export function MobileNav({
  userRole,
  pendingCount,
  inboxCount,
  invoicesAwaitingCount,
}: Props) {
  const pathname = usePathname()
  const items = MOBILE_TABBAR_BY_ROLE[userRole]
  const counts: Record<NavBadgeKey, number> = {
    pendingCount,
    inboxCount,
    invoicesAwaitingCount,
  }

  return (
    <nav
      aria-label="Главная навигация"
      className="no-print lg:hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-border pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex justify-around">
        {items.map((item) => {
          const Icon = item.icon
          // /dashboard — точное совпадение (иначе startsWith матчит вложенные),
          // остальные — совпадение или дочерний роут.
          const active =
            item.href === '/dashboard'
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + '/')
          const badgeValue = item.badge ? counts[item.badge] : 0

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-1 py-1.5 min-h-[44px] [touch-action:manipulation] transition-colors motion-reduce:transition-none',
                active ? 'text-brand-green-deep' : 'text-fg-subtle'
              )}
            >
              <span className="relative">
                <Icon
                  className="w-5 h-5"
                  strokeWidth={active ? 2.3 : 1.8}
                  aria-hidden="true"
                />
                {item.badge && badgeValue > 0 && (
                  <span className="absolute top-[-4px] right-[-8px] inline-flex items-center justify-center min-w-3.5 h-3.5 px-1 rounded-full bg-brand-orange text-white text-[8px] font-extrabold tabular-nums">
                    {badgeValue > 9 ? '9+' : badgeValue}
                  </span>
                )}
              </span>
              <span className={cn('text-[10px]', active ? 'font-bold' : 'font-medium')}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
