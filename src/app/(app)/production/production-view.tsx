'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, ChevronDown, AlertTriangle, ChefHat, Carrot, Info, Printer } from 'lucide-react'
import { formatDateShort, formatDateNumeric, formatMoney } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { DISH_CATEGORY_LABELS, DISH_CATEGORY_ICONS, DISH_CATEGORY_ORDER } from '@/lib/constants/dish-categories'
import { cn } from '@/lib/utils/cn'
import type { ProductionSummary, IngredientsSummary, IngredientProductionRow } from '@/lib/db/queries/production'
import type { MealType, DishCategory } from '@prisma/client'

interface Props {
  summary: ProductionSummary
  ingredientsSummary: IngredientsSummary
  targetDateIso: string
  tab: 'dishes' | 'ingredients'
}

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

export function ProductionView({ summary, ingredientsSummary, targetDateIso, tab }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [, startTransition] = useTransition()

  const targetDate = new Date(targetDateIso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = targetDate.getTime() === today.getTime()
  const isTomorrow = targetDate.getTime() === tomorrow.getTime()

  function updateParams(patch: Record<string, string | null>) {
    const url = new URL(window.location.href)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
    }
    startTransition(() => {
      router.push(`${pathname}?${url.searchParams.toString()}`)
    })
  }

  function shiftDate(days: number) {
    const d = new Date(targetDate)
    d.setDate(d.getDate() + days)
    updateParams({ date: d.toISOString() })
  }

  function jumpTo(date: Date) {
    updateParams({ date: date.toISOString() })
  }

  return (
    <div className="space-y-5">
      {/* Шапка с навигацией по дате */}
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => jumpTo(today)}
              className={cn(
                'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                isToday ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
              )}
            >
              Сегодня
            </button>
            <button
              type="button"
              onClick={() => jumpTo(tomorrow)}
              className={cn(
                'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                isTomorrow ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
              )}
            >
              Завтра
            </button>
            <Link
              href={`/production/print?date=${targetDateIso.slice(0, 10)}`}
              className="px-3 py-1.5 rounded-pill bg-bg hover:bg-border text-fg-muted hover:text-fg text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Печать</span>
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => shiftDate(-1)}
            aria-label="Предыдущий день"
            className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-3 flex-1 text-center">
            <p className="font-semibold text-base capitalize">{formatDateShort(targetDate)}</p>
            <p className="text-xs text-fg-muted">{formatDateNumeric(targetDate)}</p>
          </div>
          <button
            type="button"
            onClick={() => shiftDate(1)}
            aria-label="Следующий день"
            className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Агрегаты + табы */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <AggregateCard label="Всего порций" value={summary.totalPortions.toString()} />
        <AggregateCard label="Сумма" value={formatMoney(summary.totalRevenue)} />
        <AggregateCard
          label="В ожидании подтверждения"
          value={summary.pendingPortions > 0 ? `+${summary.pendingPortions}` : '—'}
          tone={summary.pendingPortions > 0 ? 'warning' : 'neutral'}
          hint={summary.pendingPortions > 0 ? 'Могут прибавиться к плану' : 'Все подтверждены'}
        />
      </div>

      {/* Предупреждение про PENDING */}
      {summary.pendingPortions > 0 && (
        <div className="rounded-2xl bg-warning-bg/40 border border-warning/20 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium text-warning-fg">
              На эту дату ещё {summary.pendingPortions} порций ждут подтверждения
            </p>
            <p className="text-xs text-warning-fg/80 mt-0.5">
              Эти заказы могут увеличить потребности после ввода менеджером. Дождитесь cut-off в 18:00.
            </p>
          </div>
        </div>
      )}

      {/* Предупреждение про отсутствующее меню */}
      {!summary.hasMenu && summary.totalPortions > 0 && (
        <div className="rounded-2xl bg-danger-bg/40 border border-danger/20 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-danger-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-sm">
            <p className="font-medium text-danger-fg">
              Меню на эту дату не утверждено
            </p>
            <p className="text-xs text-danger-fg/80 mt-0.5">
              Заказы есть ({summary.totalPortions} порций), но непонятно какие блюда готовить. Утвердите меню в разделе «Меню».
            </p>
          </div>
        </div>
      )}

      {/* Табы Блюда / Сырьё */}
      <div className="flex items-center gap-1 p-1 bg-bg rounded-pill w-fit">
        <TabButton
          active={tab === 'dishes'}
          onClick={() => updateParams({ tab: null })} // dishes — дефолт, убираем из URL
          icon={ChefHat}
          label="Блюда"
        />
        <TabButton
          active={tab === 'ingredients'}
          onClick={() => updateParams({ tab: 'ingredients' })}
          icon={Carrot}
          label="Сырьё"
        />
      </div>

      {/* Контент */}
      {tab === 'dishes' && <DishesTab summary={summary} />}
      {tab === 'ingredients' && <IngredientsTab summary={ingredientsSummary} />}
    </div>
  )
}

function DishesTab({ summary }: { summary: ProductionSummary }) {
  const hasAnyOrders = summary.totalPortions > 0
  if (!hasAnyOrders) {
    return (
      <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
        <ChefHat className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
        <p className="font-medium text-fg mb-1">На эту дату нет активных заказов</p>
        <p className="text-sm">Производство не требуется.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {MEAL_TYPE_ORDER.map((mt) => {
        const data = summary.mealTypes[mt]
        if (data.totalPortions === 0) return null

        return (
          <div key={mt} className="space-y-3">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h2 className="text-lg font-semibold">
                {MEAL_TYPE_LABELS[mt]}
                <span className="ml-2 text-fg-muted text-sm font-normal">
                  · {data.totalPortions} порций
                </span>
              </h2>
              {!data.menuApproved && data.totalPortions > 0 && (
                <span className="text-xs text-danger-fg flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Меню не утверждено
                </span>
              )}
            </div>

            {data.dishes.length === 0 ? (
              <div className="rounded-2xl bg-bg/40 border border-border border-dashed p-6 text-center text-sm text-fg-muted">
                Меню для этого типа питания не задано или не утверждено
              </div>
            ) : (
              <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
                {/* Группируем блюда по slot category для красивой подачи */}
                {groupByCategory(data.dishes).map((group, idx) => (
                  <div key={group.category} className={cn(idx > 0 && 'border-t border-border')}>
                    {group.dishes.map((dish, dishIdx) => (
                      <div
                        key={dish.dishId + '-' + dishIdx}
                        className={cn(
                          'p-4 flex items-center gap-3',
                          dishIdx > 0 && 'border-t border-border/50'
                        )}
                      >
                        <div className="w-10 h-10 rounded-full bg-bg flex items-center justify-center text-lg shrink-0" aria-hidden>
                          {DISH_CATEGORY_ICONS[dish.category as DishCategory]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{dish.dishName}</div>
                          <div className="text-xs text-fg-muted">
                            {DISH_CATEGORY_LABELS[dish.category as DishCategory]}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-2xl font-bold tabular-nums">{dish.totalPortions}</div>
                          <div className="text-xs text-fg-muted">порций</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="px-4 py-3 bg-bg/30 border-t border-border text-xs text-fg-muted flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  {data.dishes[0]?.ordersCount} заказов · {data.dishes[0]?.locationsCount} точек · сумма {formatMoney(data.totalRevenue)}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function groupByCategory(dishes: ProductionSummary['mealTypes']['LUNCH']['dishes']) {
  const map = new Map<string, typeof dishes>()
  for (const d of dishes) {
    if (!map.has(d.category)) map.set(d.category, [])
    map.get(d.category)!.push(d)
  }
  // Сортируем категории в правильном порядке (через DISH_CATEGORY_ORDER)
  const sorted = Array.from(map.entries()).sort((a, b) => {
    const ai = DISH_CATEGORY_ORDER.indexOf(a[0] as DishCategory)
    const bi = DISH_CATEGORY_ORDER.indexOf(b[0] as DishCategory)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })
  return sorted.map(([category, dishes]) => ({ category, dishes }))
}

function AggregateCard({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'warning' | 'info'
  hint?: string
}) {
  const toneClasses = {
    neutral: 'bg-surface border-border',
    warning: 'bg-warning-bg/30 border-warning/20',
    info: 'bg-info-bg/30 border-info/20',
  }
  return (
    <div className={cn('rounded-2xl border p-4', toneClasses[tone])} style={{ boxShadow: 'var(--shadow-card)' }}>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-4 py-1.5 rounded-pill text-sm font-medium transition-colors flex items-center gap-2',
        active ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}

function IngredientsTab({ summary }: { summary: IngredientsSummary }) {
  if (!summary.hasMenu) {
    return (
      <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
        <Carrot className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
        <p className="font-medium text-fg mb-1">Меню не утверждено</p>
        <p className="text-sm">Без утверждённого меню невозможно посчитать потребности по сырью.</p>
      </div>
    )
  }

  if (summary.rows.length === 0) {
    return (
      <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
        <Carrot className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
        <p className="font-medium text-fg mb-1">Нет потребностей в сырье</p>
        <p className="text-sm">На эту дату не нашлось активных заказов или блюд с тех. картами.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Маржа сверху */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <AggregateCard label="Выручка" value={formatMoney(summary.totalRevenue)} tone="info" />
        <AggregateCard
          label="Закупка"
          value={formatMoney(summary.totalCost)}
          hint={`${summary.rows.length} ингредиентов`}
        />
        <AggregateCard
          label="Маржа (ориентир)"
          value={formatMoney(summary.estimatedMargin)}
          tone={summary.estimatedMargin > 0 ? 'info' : 'warning'}
          hint={
            summary.totalRevenue > 0
              ? `${Math.round((summary.estimatedMargin / summary.totalRevenue) * 100)}% от выручки`
              : undefined
          }
        />
      </div>

      {/* Таблица ингредиентов */}
      <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium w-10"></th>
                <th className="text-left px-3 py-3 font-medium">Ингредиент</th>
                <th className="text-right px-3 py-3 font-medium">Нужно</th>
                <th className="text-right px-3 py-3 font-medium hidden md:table-cell">Цена</th>
                <th className="text-right px-3 py-3 font-medium">Стоимость</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.rows.map((row) => (
                <IngredientRow key={row.ingredientId} row={row} />
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-bg/30 border-t-2 border-border">
                <td colSpan={4} className="px-4 py-3 text-right text-sm font-semibold">
                  Итого закупка:
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-bold text-base">
                  {formatMoney(summary.totalCost)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <p className="text-xs text-fg-subtle text-center">
        * Расчёт по тех. картам блюд (брутто). Цены из последней записи в справочнике сырья.
      </p>
    </div>
  )
}

function IngredientRow({ row }: { row: IngredientProductionRow }) {
  const [expanded, setExpanded] = useState(false)
  const unitLabel = row.unit === 'KG' ? 'кг' : row.unit === 'L' ? 'л' : 'шт'

  function formatAmount(value: number): string {
    if (row.unit === 'PCS') return Math.ceil(value).toString()
    return value.toFixed(2)
  }

  return (
    <>
      <tr
        className="hover:bg-bg/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-4 py-3 text-fg-subtle">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        <td className="px-3 py-3 font-medium">{row.ingredientName}</td>
        <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">
          {formatAmount(row.totalNeeded)} {unitLabel}
        </td>
        <td className="px-3 py-3 text-right tabular-nums text-fg-muted hidden md:table-cell whitespace-nowrap">
          {formatMoney(row.pricePerUnit)} / {unitLabel}
        </td>
        <td className="px-3 py-3 text-right tabular-nums font-semibold whitespace-nowrap">
          {formatMoney(row.totalCost)}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-bg/20">
          <td colSpan={5} className="px-12 py-3">
            <p className="text-xs uppercase tracking-wider text-fg-subtle mb-2">
              Используется в блюдах
            </p>
            <ul className="space-y-1.5 text-xs">
              {row.usages.map((u, idx) => (
                <li key={u.dishId + '-' + idx} className="flex items-baseline justify-between gap-3">
                  <span className="text-fg">
                    <span className="font-medium">{u.dishName}</span>
                    <span className="text-fg-muted ml-2">
                      {u.bruttoPerPortion} {u.unit === 'PCS' ? 'шт' : 'г'} × {u.portions} порций
                    </span>
                  </span>
                  <span className="text-fg-muted tabular-nums whitespace-nowrap">
                    = {formatAmount(u.totalNeeded)} {unitLabel}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}
