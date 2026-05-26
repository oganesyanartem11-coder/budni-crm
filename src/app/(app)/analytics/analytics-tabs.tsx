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
    <nav className="flex gap-1.5 flex-wrap" aria-label="Разделы аналитики">
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
            className={cn(
              'px-4 py-2 rounded-pill text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-fg'
                : 'bg-surface text-fg-muted hover:text-fg hover:bg-border border border-border'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
