'use client'

import { useState, useMemo, useTransition } from 'react'
import { Search, Plus, Edit2, Archive, ArchiveRestore, ChevronDown, Wheat } from 'lucide-react'
import { toast } from 'sonner'
import { IngredientModal } from './ingredient-modal'
import { archiveIngredient } from './actions'
import { formatMoney, formatDateLong, formatIngredients } from '@/lib/utils/format'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils/cn'
import type { Ingredient, IngredientPriceHistory } from '@prisma/client'

type PriceFilter = 'all' | 'priced' | 'unpriced'

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
  canSeePrices: boolean
  canEdit: boolean
}

export function IngredientsTable({ ingredients, canSeePrices, canEdit }: Props) {
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all')
  const [modalState, setModalState] = useState<{ open: boolean; ingredient?: SerializedIngredient }>({
    open: false,
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [, startArchive] = useTransition()

  const filtered = useMemo(() => {
    return ingredients.filter((ing) => {
      if (!showArchived && !ing.isActive) return false
      if (search && !ing.name.toLowerCase().includes(search.toLowerCase())) return false
      if (canSeePrices && priceFilter === 'unpriced' && ing.pricePerUnit > 0) return false
      if (canSeePrices && priceFilter === 'priced' && ing.pricePerUnit === 0) return false
      return true
    })
  }, [ingredients, search, showArchived, priceFilter, canSeePrices])

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

  // Если в базе ингредиентов вообще нет — empty state без поиска/чекбокса.
  if (ingredients.length === 0) {
    return (
      <>
        <div
          className="w-full rounded-3xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center min-h-[400px]"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <Wheat className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
          <p className="font-medium text-fg mb-1">Сырья пока нет</p>
          <p className="text-sm text-fg-muted max-w-sm mb-5">Добавьте первый ингредиент в справочник.</p>
          {canEdit && (
            <button
              type="button"
              onClick={() => setModalState({ open: true })}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              Добавить ингредиент
            </button>
          )}
        </div>

        <IngredientModal
          open={modalState.open}
          ingredient={modalState.ingredient}
          onClose={() => setModalState({ open: false })}
          canSeePrices={canSeePrices}
        />
      </>
    )
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

          <div className="flex items-center gap-3 flex-wrap">
            {canSeePrices && (
              <Select value={priceFilter} onValueChange={(v) => setPriceFilter(v as PriceFilter)}>
                <SelectTrigger className="!h-auto px-3 py-2 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors text-sm data-placeholder:text-fg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все цены</SelectItem>
                  <SelectItem value="priced">С ценой</SelectItem>
                  <SelectItem value="unpriced">Без цены</SelectItem>
                </SelectContent>
              </Select>
            )}

            <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded"
              />
              Показать архивные
            </label>

            {canEdit && (
              <button
                type="button"
                onClick={() => setModalState({ open: true })}
                className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Добавить</span>
              </button>
            )}
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
                  {canSeePrices && <th className="text-right px-3 py-3 font-medium">Цена</th>}
                  {canSeePrices && <th className="text-left px-3 py-3 font-medium hidden md:table-cell">Изменена</th>}
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
                      canSeePrices={canSeePrices}
                      canEdit={canEdit}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Подвал */}
        {(search.length > 0 || showArchived || priceFilter !== 'all') && (
          <div className="px-5 py-3 text-xs text-fg-subtle border-t border-border">
            {formatIngredients(filtered.length)} из {ingredients.length}
          </div>
        )}
      </div>

      <IngredientModal
        open={modalState.open}
        ingredient={modalState.ingredient}
        onClose={() => setModalState({ open: false })}
        canSeePrices={canSeePrices}
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
  canSeePrices,
  canEdit,
}: {
  ingredient: SerializedIngredient
  isExpanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onArchive: () => void
  lastPriceChange?: SerializedPriceHistory
  canSeePrices: boolean
  canEdit: boolean
}) {
  const totalCols = 3 + (canSeePrices ? 2 : 0)
  return (
    <>
      <tr className={cn('hover:bg-bg/30 transition-colors', !ing.isActive && 'opacity-50')}>
        <td className="px-5 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{ing.name}</span>
            {canSeePrices && ing.pricePerUnit === 0 && (
              <Badge className="bg-warning-bg text-warning-fg border-warning/20 hover:bg-warning-bg">Без цены</Badge>
            )}
          </div>
          {ing.notes && (
            <div className="text-xs text-fg-muted mt-0.5">{ing.notes}</div>
          )}
        </td>
        <td className="px-3 py-3 text-fg-muted">{UNIT_LABELS[ing.unit]}</td>
        {canSeePrices && (
          <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">
            {formatMoney(ing.pricePerUnit)}
          </td>
        )}
        {canSeePrices && (
          <td className="px-3 py-3 text-fg-muted text-sm hidden md:table-cell whitespace-nowrap">
            {lastPriceChange ? formatDateLong(lastPriceChange.validFrom) : '—'}
          </td>
        )}
        <td className="px-3 py-3">
          <div className="flex items-center justify-end gap-1">
            {canSeePrices && (
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
            )}
            <button
              type="button"
              onClick={canEdit ? onEdit : undefined}
              disabled={!canEdit}
              aria-label="Редактировать"
              title={canEdit ? 'Редактировать' : 'Скоро: предложить изменение'}
              className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              <Edit2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={canEdit ? onArchive : undefined}
              disabled={!canEdit}
              aria-label={ing.isActive ? 'В архив' : 'Восстановить'}
              title={canEdit ? (ing.isActive ? 'В архив' : 'Восстановить') : 'Скоро: предложить изменение'}
              className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted"
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

      {isExpanded && canSeePrices && (
        <tr>
          <td colSpan={totalCols} className="px-5 py-4 bg-bg/30">
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
