'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_GROUPS, HOME_BY_ROLE, type NavBadgeKey, type NavItem } from '@/lib/navigation'
import { Logo } from './logo'
import { ProfileMenu } from './profile-menu'
import { cn } from '@/lib/utils/cn'
import type { UserRole } from '@prisma/client'

interface SidebarProps {
  userRole: UserRole
  userName: string
  initials: string
  pendingCount: number
  inboxCount: number
}

export function Sidebar({ userRole, userName, initials, pendingCount, inboxCount }: SidebarProps) {
  const pathname = usePathname()
  const counts: Record<NavBadgeKey, number> = {
    pendingCount,
    inboxCount,
  }

  return (
    <aside className="hidden lg:flex w-[220px] shrink-0 h-screen sticky top-0 flex-col border-r border-border bg-bg">
      <div className="flex items-center px-5 py-5">
        <Logo size="md" href={HOME_BY_ROLE[userRole]} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-5">
        <NavGroupList pathname={pathname} userRole={userRole} counts={counts} />
      </nav>

      <div className="border-t border-border px-3 py-3">
        <ProfileMenu name={userName} initials={initials} role={userRole} variant="desktop" />
      </div>
    </aside>
  )
}

/**
 * Общий рендер групп навигации — переиспользуется в Sidebar (десктоп) и
 * MobileDrawer. В групе видны только пункты с подходящей ролью; пустая
 * группа после фильтрации не показывается вовсе.
 */
export function NavGroupList({
  pathname,
  userRole,
  counts,
  onItemClick,
}: {
  pathname: string
  userRole: UserRole
  counts: Record<NavBadgeKey, number>
  onItemClick?: () => void
}) {
  return (
    <>
      {NAV_GROUPS.map((group) => {
        const visible = group.items.filter((it) => it.roles.includes(userRole))
        if (visible.length === 0) return null
        return (
          <div key={group.id} className="space-y-0.5">
            <p className="px-3 mb-1 text-xs lg:text-[10px] uppercase tracking-wider text-fg-subtle font-semibold">
              {group.title}
            </p>
            {visible.map((item) => (
              <NavLinkRow
                key={item.href}
                item={item}
                active={isActive(pathname, item.href)}
                badge={item.badge ? counts[item.badge] : 0}
                onClick={onItemClick}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

function NavLinkRow({
  item,
  active,
  badge,
  onClick,
}: {
  item: NavItem
  active: boolean
  badge: number
  onClick?: () => void
}) {
  const Icon = item.icon
  const showBadge = badge > 0
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-xl text-base lg:text-sm transition-colors',
        active
          ? 'bg-fg/5 text-fg font-medium'
          : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
      )}
    >
      <Icon className="w-5 h-5 lg:w-4 lg:h-4 shrink-0" strokeWidth={active ? 2 : 1.75} />
      <span className="flex-1 truncate">{item.label}</span>
      {showBadge && (
        <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-danger text-accent-fg text-[10px] font-bold tabular-nums">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  )
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  // /dashboard не должен подсвечиваться когда мы в /dashboard/something-else,
  // но /orders должен подсвечиваться для /orders/new, /orders/[id], /orders/confirm.
  return pathname.startsWith(href + '/')
}
