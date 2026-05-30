'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import {
  TOP_NAV,
  NAV_GROUPS,
  BOTTOM_NAV,
  HOME_BY_ROLE,
  type NavBadgeKey,
  type NavItem,
} from '@/lib/navigation'
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
  invoicesAwaitingCount: number
}

/**
 * Десктоп-Sidebar (Волна 2 — вариант A «Bento Editorial»).
 *
 * Collapsed icon-only 72px → hover-expand 232px. Тёмно-зелёный градиент
 * (from-sidebar → to-sidebar-bg-end). Раскрытие управляется CSS `group`-hover
 * на <aside>: ширина анимируется transition-[width], а лейблы/заголовки групп
 * проявляются через opacity 0→100 на group-hover. Все transition отключаются
 * при prefers-reduced-motion (motion-reduce:transition-none).
 */
export function Sidebar({
  userRole,
  userName,
  initials,
  pendingCount,
  inboxCount,
  invoicesAwaitingCount,
}: SidebarProps) {
  const pathname = usePathname()
  const counts: Record<NavBadgeKey, number> = {
    pendingCount,
    inboxCount,
    invoicesAwaitingCount,
  }

  const topVisible = TOP_NAV.filter((it) => it.roles.includes(userRole))
  const bottomVisible = BOTTOM_NAV.filter((it) => it.roles.includes(userRole))

  return (
    <aside
      className={cn(
        'no-print group hidden lg:flex shrink-0 h-screen sticky top-0 flex-col overflow-x-hidden',
        'w-[72px] hover:w-[232px] transition-[width] duration-200 ease-out motion-reduce:transition-none',
        'border-r border-sidebar-border bg-linear-to-b from-sidebar to-sidebar-bg-end text-sidebar-foreground'
      )}
    >
      {/* Лого + wordmark «Будни / КАК ДОМА» (подзаголовок проявляется на hover) */}
      <div className="flex items-center px-3 h-16 shrink-0 overflow-hidden">
        <Logo size="md" href={HOME_BY_ROLE[userRole]} onDark />
        <span
          className={cn(
            'ml-2 text-[10px] uppercase tracking-wider font-semibold text-sidebar-muted whitespace-nowrap',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none'
          )}
        >
          Как дома
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2 space-y-4">
        {/* TOP_NAV — Дашборд (перед группами) */}
        {topVisible.length > 0 && (
          <div className="space-y-0.5">
            {topVisible.map((item) => (
              <NavLinkRow
                key={item.href}
                item={item}
                active={isActive(pathname, item.href)}
                badge={item.badge ? counts[item.badge] : 0}
              />
            ))}
          </div>
        )}

        {/* NAV_GROUPS — sales / production / more */}
        {NAV_GROUPS.map((group) => {
          const visible = group.items.filter((it) => it.roles.includes(userRole))
          if (visible.length === 0) return null
          return (
            <div key={group.id} className="space-y-0.5">
              <p
                className={cn(
                  'px-3 mb-1 text-[10px] uppercase tracking-wider font-semibold text-sidebar-muted',
                  'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none',
                  'whitespace-nowrap truncate'
                )}
              >
                {group.title}
              </p>
              {visible.map((item) => {
                if (item.children && item.children.length > 0) {
                  return (
                    <NavExpandableRow
                      key={item.href}
                      item={item}
                      pathname={pathname}
                      userRole={userRole}
                      counts={counts}
                    />
                  )
                }
                return (
                  <NavLinkRow
                    key={item.href}
                    item={item}
                    active={isActive(pathname, item.href)}
                    badge={item.badge ? counts[item.badge] : 0}
                  />
                )
              })}
            </div>
          )
        })}

        {/* BOTTOM_NAV — Борис (после групп) */}
        {bottomVisible.length > 0 && (
          <div className="space-y-0.5">
            {bottomVisible.map((item) => (
              <NavLinkRow
                key={item.href}
                item={item}
                active={isActive(pathname, item.href)}
                badge={item.badge ? counts[item.badge] : 0}
              />
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-sidebar-border px-2 py-2">
        <ProfileMenu name={userName} initials={initials} role={userRole} variant="desktop" />
      </div>
    </aside>
  )
}

function NavLinkRow({
  item,
  active,
  badge,
}: {
  item: NavItem
  active: boolean
  badge: number
}) {
  const Icon = item.icon
  const showBadge = badge > 0
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-3 min-h-10 px-3 py-2.5 rounded-[9px] text-sm',
        'transition-colors motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40 focus-visible:ring-offset-2',
        active
          ? 'bg-brand-green text-sidebar-foreground font-medium'
          : 'text-sidebar-muted hover:bg-sidebar-accent'
      )}
    >
      <span className="relative shrink-0">
        <Icon className="w-[18px] h-[18px]" strokeWidth={active ? 2 : 1.7} />
        {/* collapsed: бейдж абсолютно у иконки (виден всегда, и в collapsed) */}
        {showBadge && (
          <span className="group-hover:hidden absolute -top-1 -right-1 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-brand-orange text-white text-[9px] font-extrabold tabular-nums">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      <span
        className={cn(
          'flex-1 truncate whitespace-nowrap',
          'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none'
        )}
      >
        {item.label}
      </span>
      {/* expanded: бейдж справа от лейбла */}
      {showBadge && (
        <span className="hidden group-hover:inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-brand-orange text-white text-[9px] font-extrabold tabular-nums opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  )
}

/**
 * Раскрываемый узел с дочерними ссылками. Состояние «развёрнут»:
 *  - lazy initial: если pathname matches любой child — true
 *  - дальше — localStorage ('sidebar.{href}.expanded')
 *  - при навигации на child — auto-expand через effect (без mismatch:
 *    initial уже учёл pathname)
 *
 * SSR-safety: lazy initializer вычисляется на сервере только из pathname
 * (нет окна), на клиенте при первом рендере тоже — синхронный matching
 * без чтения localStorage в initial. localStorage применяется в effect
 * (после mount), но фолбэк-значение совпадает с pathname-вычислением, так
 * что hydration mismatch не возникает.
 *
 * В collapsed (72px) состоянии раскрытый список детей всё равно отрендерен
 * в DOM, но визуально это поведение приемлемо: лейблы детей скрыты opacity,
 * а сам узел читается как обычный пункт (иконка + collapsed-бейдж). Логика
 * expand/collapse не тронута — только перекрашено под DNA.
 */
function NavExpandableRow({
  item,
  pathname,
  userRole,
  counts,
}: {
  item: NavItem
  pathname: string
  userRole: UserRole
  counts: Record<NavBadgeKey, number>
}) {
  const visibleChildren = (item.children ?? []).filter((c) => c.roles.includes(userRole))
  const pathMatches = visibleChildren.some((c) => isActive(pathname, c.href))
  const parentActive = pathMatches || isActive(pathname, item.href)

  // lazy initializer — детерминированно из pathname (одинаково на SSR и client).
  const [expanded, setExpanded] = useState<boolean>(() => pathMatches)

  // После mount — читаем localStorage (если был явно закрыт юзером). Если
  // pathMatches — всегда показываем открытым (auto-expand при навигации).
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (pathMatches) {
      setExpanded(true)
      return
    }
    try {
      const stored = window.localStorage.getItem(`sidebar.${item.href}.expanded`)
      if (stored === 'true') setExpanded(true)
      else if (stored === 'false') setExpanded(false)
    } catch {
      // приватный режим Safari / отключённый storage — игнорируем.
    }
  }, [pathMatches, item.href])

  function toggle() {
    setExpanded((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(`sidebar.${item.href}.expanded`, String(next))
        } catch {
          // ignore
        }
      }
      return next
    })
  }

  if (visibleChildren.length === 0) return null

  const Icon = item.icon

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={cn(
          'w-full relative flex items-center gap-3 min-h-10 px-3 py-2.5 rounded-[9px] text-sm',
          'transition-colors motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40 focus-visible:ring-offset-2',
          parentActive
            ? 'bg-brand-green text-sidebar-foreground font-medium'
            : 'text-sidebar-muted hover:bg-sidebar-accent'
        )}
      >
        <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={parentActive ? 2 : 1.7} />
        <span
          className={cn(
            'flex-1 truncate whitespace-nowrap text-left',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none'
          )}
        >
          {item.label}
        </span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 shrink-0 text-sidebar-muted',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded && (
        <div className="ml-3 pl-3 border-l border-sidebar-border space-y-0.5">
          {visibleChildren.map((child) => {
            const ChildIcon = child.icon
            const childActive = isActive(pathname, child.href)
            const badge = child.badge ? counts[child.badge] : 0
            return (
              <Link
                key={child.href + child.label}
                href={child.href}
                aria-current={childActive ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-3 min-h-10 px-3 py-1.5 rounded-[9px] text-sm',
                  'transition-colors motion-reduce:transition-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40 focus-visible:ring-offset-2',
                  childActive
                    ? 'bg-brand-green text-sidebar-foreground font-medium'
                    : 'text-sidebar-muted hover:bg-sidebar-accent'
                )}
              >
                <span className="relative shrink-0">
                  <ChildIcon className="w-[18px] h-[18px]" strokeWidth={childActive ? 2 : 1.7} />
                  {badge > 0 && (
                    <span className="group-hover:hidden absolute -top-1 -right-1 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-brand-orange text-white text-[9px] font-extrabold tabular-nums">
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'flex-1 truncate whitespace-nowrap',
                    'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none'
                  )}
                >
                  {child.label}
                </span>
                {badge > 0 && (
                  <span className="hidden group-hover:inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-brand-orange text-white text-[9px] font-extrabold tabular-nums opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  // /dashboard не должен подсвечиваться когда мы в /dashboard/something-else,
  // но /orders должен подсвечиваться для /orders/new, /orders/[id], /orders/confirm.
  return pathname.startsWith(href + '/')
}
