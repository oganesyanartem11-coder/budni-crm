'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Search, Edit2 } from 'lucide-react'
import type { Dish, DishCategory, DishIngredient, Ingredient } from '@prisma/client'
import {
  DISH_CATEGORY_LABELS,
  DISH_CATEGORY_PLURAL,
  DISH_CATEGORY_ICONS,
  DISH_CATEGORY_ORDER,
} from '@/lib/constants/dish-categories'
import { formatMoney } from '@/lib/utils/format'
import { calculateDishCost } from '@/lib/utils/dish-cost'
import { cn } from '@/lib/utils/cn'

// Сериализованные типы
type SerializedIngredient = Omit<Ingredient, 'pricePerUnit'> & { pricePerUnit: number }
type SerializedDishIngredient = Omit<DishIngredient, 'bruttoGrams' | 'nettoGrams'> & {
  bruttoGrams: number
  nettoGrams: number
  ingredient: SerializedIngredient
}
type SerializedDish = Dish & {
  ingredients: SerializedDishIngredient[]
}

interface Props {
  dishes: SerializedDish[]
  canEdit: boolean
}

type FilterCategory = DishCategory | 'ALL'

export function DishesGrid({ dishes, canEdit }: Props) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterCategory>('ALL')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Считаем количество в каждой категории для бейджей фильтров
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { ALL: dishes.length }
    for (const cat of DISH_CATEGORY_ORDER) {
      counts[cat] = dishes.filter((d) => d.category === cat).length
    }
    return counts
  }, [dishes])

  const filtered = useMemo(() => {
    return dishes.filter((d) => {
      if (filter !== 'ALL' && d.category !== filter) return false
      if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [dishes, search, filter])

  // Категории, у которых > 0 блюд (показываем только их в фильтрах)
  const availableCategories = DISH_CATEGORY_ORDER.filter((cat) => categoryCounts[cat] > 0)

  return (
    <div className="space-y-5">
      {/* Поиск + фильтры */}
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
          <input
            type="search"
            placeholder="Поиск по названию"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none -mx-1 px-1">
          <FilterPill
            active={filter === 'ALL'}
            onClick={() => setFilter('ALL')}
            label="Все"
            count={categoryCounts.ALL}
          />
          {availableCategories.map((cat) => (
            <FilterPill
              key={cat}
              active={filter === cat}
              onClick={() => setFilter(cat)}
              label={DISH_CATEGORY_PLURAL[cat]}
              count={categoryCounts[cat]}
            />
          ))}
        </div>
      </div>

      {/* Сетка карточек */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          {search ? `Ничего не найдено по запросу «${search}»` : 'Нет блюд в этой категории'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((dish) => (
            <DishCard
              key={dish.id}
              dish={dish}
              expanded={expandedId === dish.id}
              onToggle={() => setExpandedId(expandedId === dish.id ? null : dish.id)}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-fg-subtle text-center">
        Показано: {filtered.length} из {dishes.length}
      </p>
    </div>
  )
}

function FilterPill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 px-3.5 py-1.5 rounded-pill text-sm font-medium transition-all flex items-center gap-1.5',
        active
          ? 'bg-accent text-accent-fg'
          : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
      )}
    >
      {label}
      <span className={cn(
        'text-xs px-1.5 py-0.5 rounded-full',
        active ? 'bg-white/15 text-accent-fg' : 'bg-surface text-fg-subtle'
      )}>
        {count}
      </span>
    </button>
  )
}

function DishCard({
  dish,
  expanded,
  onToggle,
  canEdit,
}: {
  dish: SerializedDish
  expanded: boolean
  onToggle: () => void
  canEdit: boolean
}) {
  const [scale, setScale] = useState<1 | 10>(1) // 1 порция или 10 порций

  const cost = useMemo(() => calculateDishCost(dish.ingredients), [dish.ingredients])

  const previewIngredients = dish.ingredients.slice(0, 3)
  const remainingCount = dish.ingredients.length - previewIngredients.length

  return (
    <div
      className={cn(
        'rounded-2xl bg-surface border transition-all overflow-hidden',
        expanded ? 'border-fg-muted' : 'border-border hover:border-border-strong'
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {/* Шапка карточки — кликабельная */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-5 hover:bg-bg/30 transition-colors"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <span className="text-2xl shrink-0" aria-hidden>
              {DISH_CATEGORY_ICONS[dish.category]}
            </span>
            <div className="min-w-0">
              <h3 className="font-semibold text-base truncate">{dish.name}</h3>
              <p className="text-xs text-fg-muted">
                {DISH_CATEGORY_LABELS[dish.category]}
                {dish.portionSize && ` · ${dish.portionSize} ${dish.unit === 'PIECE' ? 'г/шт' : dish.unit === 'LITER' ? 'мл' : 'г'}`}
              </p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-fg-muted">Себестоимость</p>
            <p className="font-semibold text-sm">{formatMoney(cost, { withKopecks: true })}</p>
          </div>
        </div>

        {!expanded && (
          <div className="space-y-1">
            {previewIngredients.map((line) => (
              <div key={line.id} className="flex items-baseline justify-between text-xs text-fg-muted">
                <span className="truncate pr-2">{line.ingredient.name}</span>
                <span className="shrink-0 tabular-nums">
                  {formatGrams(line.bruttoGrams, line.ingredient.unit)}
                </span>
              </div>
            ))}
            {remainingCount > 0 && (
              <p className="text-xs text-fg-subtle">+ ещё {remainingCount}</p>
            )}
          </div>
        )}
      </button>

      {/* Раскрытая часть — полная техкарта */}
      {expanded && (
        <div className="border-t border-border bg-bg/30 px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-fg-muted font-medium">
              Техкарта
            </p>
            <div className="flex gap-1 p-0.5 bg-surface rounded-pill border border-border">
              <ScaleButton active={scale === 1} onClick={() => setScale(1)} label="× 1" />
              <ScaleButton active={scale === 10} onClick={() => setScale(10)} label="× 10" />
            </div>
          </div>

          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Ингредиент</th>
                  <th className="text-right px-3 py-2 font-medium w-24">Брутто</th>
                  <th className="text-right px-3 py-2 font-medium w-24">Нетто</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dish.ingredients.map((line) => (
                  <tr key={line.id}>
                    <td className="px-3 py-2">{line.ingredient.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {formatGrams(line.bruttoGrams * scale, line.ingredient.unit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-fg-muted">
                      {formatGrams(line.nettoGrams * scale, line.ingredient.unit)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg/30">
                <tr>
                  <td className="px-3 py-2 text-xs text-fg-muted">
                    Себестоимость на {scale === 1 ? '1 порцию' : '10 порций'}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold" colSpan={2}>
                    {formatMoney(cost * scale, { withKopecks: true })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {dish.notes && (
            <div className="text-xs text-fg-muted bg-surface rounded-xl p-3 border border-border">
              <span className="font-medium">Заметки:</span> {dish.notes}
            </div>
          )}

          {canEdit && (
            <div className="pt-2 flex justify-end">
              <Link
                href={`/dishes/${dish.id}/edit`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill bg-surface border border-border-strong text-fg hover:bg-bg transition-colors text-sm font-medium"
              >
                <Edit2 className="w-3.5 h-3.5" />
                Редактировать
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ScaleButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        'px-3 py-1 rounded-pill text-xs font-medium transition-colors',
        active
          ? 'bg-accent text-accent-fg'
          : 'text-fg-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}

/**
 * Форматирует количество ингредиента с правильной единицей.
 * Для KG/L: вход в граммах/мл, выводим в г/мл (если меньше 1000) или кг/л.
 * Для PCS: вход в штуках, выводим как N шт.
 */
function formatGrams(amount: number, unit: 'KG' | 'L' | 'PCS'): string {
  if (unit === 'PCS') {
    // Округляем до 2 знаков чтобы не было 0.20000000001 шт
    const rounded = Math.round(amount * 100) / 100
    return `${rounded} шт`
  }
  // KG / L
  if (amount >= 1000) {
    return `${(amount / 1000).toFixed(2)} ${unit === 'KG' ? 'кг' : 'л'}`
  }
  return `${Math.round(amount * 10) / 10} ${unit === 'KG' ? 'г' : 'мл'}`
}
