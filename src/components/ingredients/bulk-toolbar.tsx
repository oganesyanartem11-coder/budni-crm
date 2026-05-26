'use client'

import { Combine, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface Props {
  selectedCount: number
  onMerge: () => void
  onDelete: () => void
  onClear: () => void
  className?: string
}

/**
 * Sticky-тулбар для bulk-операций над ингредиентами.
 * Виден только когда выбран хотя бы один ингредиент.
 * «Объединить» disabled при count < 2 (merge требует минимум 2 — target + 1 source).
 */
export function BulkToolbar({ selectedCount, onMerge, onDelete, onClear, className }: Props) {
  if (selectedCount < 1) return null

  const canMerge = selectedCount >= 2

  return (
    <div
      className={cn(
        'sticky top-0 z-20 flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-surface border border-border',
        className
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-fg">Выбрано {selectedCount}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onMerge}
          disabled={!canMerge}
          title={canMerge ? 'Объединить выбранные ингредиенты' : 'Выберите минимум 2 ингредиента для объединения'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Combine className="w-4 h-4" />
          <span className="hidden sm:inline">Объединить</span>
        </button>

        <button
          type="button"
          onClick={onDelete}
          title="Удалить выбранные ингредиенты"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-bg border border-border text-fg font-medium text-sm hover:bg-bg/70 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          <span className="hidden sm:inline">Удалить</span>
        </button>

        <button
          type="button"
          onClick={onClear}
          aria-label="Снять выбор"
          title="Снять выбор"
          className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
