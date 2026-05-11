'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { TOP_NAV_SECTIONS } from '@/lib/navigation'
import type { UserRole } from '@prisma/client'

interface TopNavProps {
  role: UserRole
  pendingCount?: number
  inboxCount?: number
}

export function TopNav({ role, pendingCount = 0, inboxCount = 0 }: TopNavProps) {
  const pathname = usePathname()

  const visibleSections = TOP_NAV_SECTIONS.filter(
    (section) => !section.roles || section.roles.includes(role)
  )

  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-none">
      {visibleSections.map((section) => {
        const active = pathname === section.href || pathname.startsWith(section.href + '/')
        const badgeCount =
          section.href === '/orders' ? pendingCount :
          section.href === '/inbox' ? inboxCount :
          0
        const showBadge = badgeCount > 0
        return (
          <Link
            key={section.href}
            href={section.href}
            className={cn(
              'relative px-4 py-2 rounded-pill text-sm font-medium whitespace-nowrap transition-all',
              active
                ? 'bg-accent text-accent-fg'
                : 'text-fg-muted hover:text-fg hover:bg-surface-2'
            )}
          >
            {section.label}
            {showBadge && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-danger text-accent-fg text-[10px] font-bold flex items-center justify-center">
                {badgeCount > 9 ? '9+' : badgeCount}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
