'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ProfileMenu } from './profile-menu'
import { NavGroupList } from './sidebar'
import {
  MOBILE_TABBAR_BY_ROLE,
  MORE_HREF,
  type NavBadgeKey,
} from '@/lib/navigation'
import { cn } from '@/lib/utils/cn'
import type { UserRole } from '@prisma/client'

interface Props {
  userRole: UserRole
  userName: string
  initials: string
  pendingCount: number
  inboxCount: number
}

export function MobileNav({ userRole, userName, initials, pendingCount, inboxCount }: Props) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const items = MOBILE_TABBAR_BY_ROLE[userRole]
  const counts: Record<NavBadgeKey, number> = { pendingCount, inboxCount }

  return (
    <>
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-border pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-stretch justify-around">
          {items.map((item) => {
            const Icon = item.icon
            if (item.href === MORE_HREF) {
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  aria-label="Открыть меню"
                  className={cn(
                    'flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors',
                    drawerOpen ? 'text-fg' : 'text-fg-subtle'
                  )}
                >
                  <Icon className="w-5 h-5" strokeWidth={1.75} />
                  <span className="text-[11px] font-medium">{item.label}</span>
                </button>
              )
            }
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

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-[80%] sm:w-[360px] p-0 flex flex-col">
          <SheetHeader className="px-5 py-3 border-b border-border">
            <SheetTitle className="text-base font-semibold text-left">Меню</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
            <NavGroupList
              pathname={pathname}
              userRole={userRole}
              counts={counts}
              onItemClick={() => setDrawerOpen(false)}
            />
          </div>
          <div className="border-t border-border px-3 py-2">
            <ProfileMenu name={userName} initials={initials} role={userRole} variant="desktop" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
