'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { MOBILE_TABBAR_BY_ROLE } from '@/lib/navigation'
import type { UserRole } from '@prisma/client'

interface MobileTabbarProps {
  role: UserRole
}

export function MobileTabbar({ role }: MobileTabbarProps) {
  const pathname = usePathname()
  const items = MOBILE_TABBAR_BY_ROLE[role]

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-border pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch justify-around">
        {items.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors',
                active ? 'text-fg' : 'text-fg-subtle'
              )}
            >
              <Icon className={cn('w-5 h-5', active && 'stroke-[2]')} strokeWidth={1.75} />
              <span className="text-[11px] font-medium">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
