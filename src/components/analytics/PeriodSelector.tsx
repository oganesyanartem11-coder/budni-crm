'use client'

import { useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils/cn'

export type Period = 'week' | 'month' | 'quarter' | 'year'

interface Props {
  activePeriod: Period
  basePath: string
}

const PRESETS: Array<{ key: Period; label: string }> = [
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'year', label: 'Год' },
]

/**
 * Унифицированный селектор периода для аналитических страниц.
 * Сохраняет остальные query-параметры (?group=KG и т.п.) — заменяет только `period`.
 * Используется в /analytics/invoices. Может быть переиспользован в других
 * аналитических экранах в будущем.
 */
export function PeriodSelector({ activePeriod, basePath }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  function applyPeriod(p: Period) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('period', p)
    const target = basePath || pathname
    startTransition(() => router.push(`${target}?${params.toString()}`))
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map((p) => {
        const isActive = activePeriod === p.key
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPeriod(p.key)}
            disabled={isPending}
            className={cn(
              'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors disabled:opacity-50',
              isActive
                ? 'bg-accent text-accent-fg'
                : 'bg-fg/5 text-fg-muted hover:bg-fg/10'
            )}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}
