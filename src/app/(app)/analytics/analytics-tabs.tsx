'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils/cn'

type Tab = { href: string; label: string }

interface Props {
  tabs: Tab[]
}

/**
 * Под-навигация раздела «Аналитика». Активный таб — по точному совпадению
 * pathname (а для родительского /analytics — startsWith избегает залипания
 * на детальной странице). Клиентский компонент, потому что серверный layout
 * в Next 16 App Router не имеет прямого доступа к pathname.
 */
export function AnalyticsTabs({ tabs }: Props) {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1 flex-wrap rounded-pill bg-surface-2 p-1" aria-label="Разделы аналитики">
      {tabs.map((t) => {
        // /analytics — активна только если pathname точно совпадает
        // (иначе подсветится и на /analytics/cost).
        // /analytics/cost — активна на /analytics/cost и /analytics/cost/[id].
        // /analytics/invoices — активна на /analytics/invoices (детальных
        // страниц пока нет, но startsWith — на вырост).
        const isExact = pathname === t.href
        const isBranch =
          t.href !== '/analytics' && pathname.startsWith(t.href + '/')
        const isActive = isExact || isBranch

        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isActive ? 'page' : undefined}
            style={
              isActive
                ? {
                    background: 'linear-gradient(180deg,#1F2530 0%,#10141A 100%)',
                    boxShadow: 'var(--shadow-capsule)',
                  }
                : undefined
            }
            className={cn(
              'inline-flex items-center justify-center min-h-[44px] px-4 rounded-pill text-sm font-medium transition-colors',
              isActive
                ? 'text-primary-foreground'
                : 'text-fg-muted hover:text-fg'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
