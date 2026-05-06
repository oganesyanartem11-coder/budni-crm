'use client'

import { useState, useMemo, useTransition } from 'react'
import { Search, Plus, Edit2, Archive, ArchiveRestore, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { IngredientModal } from './ingredient-modal'
import { archiveIngredient } from './actions'
import { formatMoney, formatDateLong } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { Ingredient, IngredientPriceHistory } from '@prisma/client'

const UNIT_LABELS = { KG: 'кг', L: 'л', PCS: 'шт' } as const

// Сериализованная форма: Decimal → number
type SerializedIngredient = Omit<Ingredient, 'pricePerUnit'> & {
  pricePerUnit: number
  priceHistory: SerializedPriceHistory[]
}

type SerializedPriceHistory = Omit<IngredientPriceHistory, 'price'> & {
  price: number
}

interface Props {
  ingredients: SerializedIngredient[]
}

export function IngredientsTable({ ingredients }: Props) {
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [modalState, setModalState] = useState<{ open: boolean; ingredient?: SerializedIngredient }>({
    open: false,
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [, startArchive] = useTransition()

  const filtered = useMemo(() => {
    return ingredients.filter((ing) => {
      if (!showArchived && !ing.isActive) return false
      if (search && !ing.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [ingredients, search, showArchived])

  function handleArchive(id: string, name: string, currentlyActive: boolean) {
    startArchive(async () => {
      const result = await archiveIngredient(id)
      if (result.ok) {
        toast.success(currentlyActive ? `«${name}» в архиве` : `«${name}» восстановлен`)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
        {/* Панель управления */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="relative flex-1 md:max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
            <input
              type="search"
              placeholder="Поиск по названию"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded"
              />
              Показать архивные
            </label>

            <button
              type="button"
              onClick={() => setModalState({ open: true })}
              className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Добавить</span>
            </button>
          </div>
        </div>

        {/* Таблица */}
        {filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-fg-muted">
            {search ? `Ничего не найдено по запросу «${search}»` : 'Нет ингредиентов'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th className="text-left px-5 py-3 font-medium">Название</th>
                  <th className="text-left px-3 py-3 font-medium w-20">Ед.</th>
                  <th className="text-right px-3 py-3 font-medium">Цена</th>
                  <th className="text-left px-3 py-3 font-medium hidden md:table-cell">Изменена</th>
                  <th className="px-3 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((ing) => {
                  const lastPriceChange = ing.priceHistory[0]
                  const isExpanded = expandedId === ing.id

                  return (
                    <FragmentRow
                      key={ing.id}
                      ingredient={ing}
                      isExpanded={isExpanded}
                      onToggleExpand={() => setExpandedId(isExpanded ? null : ing.id)}
                      onEdit={() => setModalState({ open: true, ingredient: ing })}
                      onArchive={() => handleArchive(ing.id, ing.name, ing.isActive)}
                      lastPriceChange={lastPriceChange}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Подвал */}
        <div className="px-5 py-3 text-xs text-fg-subtle border-t border-border">
          Показано: {filtered.length} {filtered.length === 1 ? 'ингредиент' : 'из'} {ingredients.length}
        </div>
      </div>

      <IngredientModal
        open={modalState.open}
        ingredient={modalState.ingredient}
        onClose={() => setModalState({ open: false })}
      />
    </>
  )
}

function FragmentRow({
  ingredient: ing,
  isExpanded,
  onToggleExpand,
  onEdit,
  onArchive,
  lastPriceChange,
}: {
  ingredient: SerializedIngredient
  isExpanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onArchive: () => void
  lastPriceChange?: SerializedPriceHistory
}) {
  return (
    <>
      <tr className={cn('hover:bg-bg/30 transition-colors', !ing.isActive && 'opacity-50')}>
        <td className="px-5 py-3">
          <div className="font-medium">{ing.name}</div>
          {ing.notes && (
            <div className="text-xs text-fg-muted mt-0.5">{ing.notes}</div>
          )}
        </td>
        <td className="px-3 py-3 text-fg-muted">{UNIT_LABELS[ing.unit]}</td>
        <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">
          {formatMoney(ing.pricePerUnit)}
        </td>
        <td className="px-3 py-3 text-fg-muted text-sm hidden md:table-cell whitespace-nowrap">
          {lastPriceChange ? formatDateLong(lastPriceChange.validFrom) : '—'}
        </td>
        <td className="px-3 py-3">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={onToggleExpand}
              aria-label="История цен"
              title="История цен"
              className={cn(
                'w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-all',
                isExpanded && 'bg-bg text-fg'
              )}
            >
              <ChevronDown className={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-180')} />
            </button>
            <button
              type="button"
              onClick={onEdit}
              aria-label="Редактировать"
              title="Редактировать"
              className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <Edit2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onArchive}
              aria-label={ing.isActive ? 'В архив' : 'Восстановить'}
              title={ing.isActive ? 'В архив' : 'Восстановить'}
              className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              {ing.isActive ? (
                <Archive className="w-4 h-4" />
              ) : (
                <ArchiveRestore className="w-4 h-4" />
              )}
            </button>
          </div>
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={5} className="px-5 py-4 bg-bg/30">
            <div className="text-xs uppercase tracking-wider text-fg-muted mb-2">
              История цен
            </div>
            {ing.priceHistory.length === 0 ? (
              <div className="text-sm text-fg-muted">История пуста</div>
            ) : (
              <ul className="space-y-1.5">
                {ing.priceHistory.map((h) => (
                  <li key={h.id} className="flex items-center justify-between text-sm">
                    <span className="text-fg-muted">{formatDateLong(h.validFrom)}</span>
                    <span className="font-medium">{formatMoney(h.price)}</span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
