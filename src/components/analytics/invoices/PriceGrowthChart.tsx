'use client'

import { ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { formatMoneyRu } from '@/lib/digest/format'
import { cn } from '@/lib/utils/cn'
import type { PriceGrowthRow } from '@/lib/db/queries/invoice-analytics'

interface Props {
  data: PriceGrowthRow[]
}

/**
 * W2. Список Top-10 ингредиентов с самым сильным изменением цены за период.
 * Сортировка — DESC по priceChangePercent (рост важнее падения).
 * Цвет: |change| >= 30 → warning, иначе нейтральный.
 */
export function PriceGrowthChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-muted">
        За период не было изменений цен
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {data.map((row) => {
        const isUp = row.changePercent > 0
        const isDown = row.changePercent < 0
        const absPct = Math.abs(row.changePercent)
        const isWarning = absPct >= 30
        const ArrowIcon = isUp ? ArrowUp : isDown ? ArrowDown : Minus

        return (
          <li
            key={row.ingredientId}
            className="flex items-center justify-between gap-3 py-2.5 px-1"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{row.name}</p>
              <p className="text-xs text-fg-muted tabular-nums">
                {formatMoneyRu(row.oldPrice)}
                <span className="mx-1 text-fg-subtle">→</span>
                {formatMoneyRu(row.newPrice)}
              </p>
            </div>
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-xs font-medium tabular-nums shrink-0',
                isWarning
                  ? 'bg-warning-bg/30 text-warning-fg'
                  : isUp
                    ? 'bg-fg/5 text-danger-fg'
                    : isDown
                      ? 'bg-fg/5 text-success-fg'
                      : 'bg-fg/5 text-fg-muted'
              )}
            >
              <ArrowIcon className="w-3 h-3" />
              {isUp ? '+' : ''}
              {row.changePercent.toFixed(1).replace('.', ',')}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}
