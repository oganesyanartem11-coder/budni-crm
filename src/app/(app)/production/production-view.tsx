'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight, ChevronDown, AlertTriangle, ChefHat, Wheat, Info } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { formatDateShort, formatMoney, formatOrders, formatLocations, formatPortions } from '@/lib/utils/format'
import { toMskDateString } from '@/lib/utils/msk-window'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { DISH_CATEGORY_LABELS, DISH_CATEGORY_ICONS, DISH_CATEGORY_ORDER } from '@/lib/constants/dish-categories'
import { cn } from '@/lib/utils/cn'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { ProductionSummary, IngredientsSummary, IngredientProductionRow } from '@/lib/db/queries/production'
import type { MealType, DishCategory } from '@prisma/client'

interface Props {
  summary: ProductionSummary
  ingredientsSummary: IngredientsSummary
  targetDateIso: string
  tab: 'dishes' | 'ingredients'
  canSeePrices: boolean
}

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

export function ProductionView({ summary, ingredientsSummary, targetDateIso, tab, canSeePrices }: Props) {
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
    updateParams({ date: toMskDateString(d) })
  }

  function jumpTo(date: Date) {
    updateParams({ date: toMskDateString(date) })
  }

  return (
    <div className="space-y-5">
      {/* Панель навигации по дате */}
      <div
        className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-3 sm:justify-start sm:gap-3"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <button
          type="button"
          onClick={() => shiftDate(-1)}
          aria-label="Предыдущий день"
          style={{ touchAction: 'manipulation' }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => jumpTo(today)}
            aria-pressed={isToday}
            style={{ touchAction: 'manipulation' }}
            className={cn(
              'rounded-pill px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              isToday ? 'bg-brand-green-deep text-surface' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            )}
          >
            Сегодня
          </button>
          <button
            type="button"
            onClick={() => jumpTo(tomorrow)}
            aria-pressed={isTomorrow}
            style={{ touchAction: 'manipulation' }}
            className={cn(
              'rounded-pill px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              isTomorrow ? 'bg-brand-green-deep text-surface' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            )}
          >
            Завтра
          </button>
        </div>

        <span className="hidden px-1 text-sm text-fg-subtle sm:inline" aria-hidden="true">·</span>
        <p className="order-last w-full text-center text-sm font-semibold capitalize text-fg sm:order-none sm:w-auto sm:whitespace-nowrap">
          {formatDateShort(targetDate)}
        </p>

        <button
          type="button"
          onClick={() => shiftDate(1)}
          aria-label="Следующий день"
          style={{ touchAction: 'manipulation' }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Агрегаты + табы */}
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', canSeePrices ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        <AggregateCard label="Всего порций" value={summary.totalPortions.toString()} />
        {canSeePrices && <AggregateCard label="Сумма" value={formatMoney(summary.totalRevenue)} />}
        <AggregateCard
          label="В ожидании подтверждения"
          value={summary.pendingPortions > 0 ? `+${summary.pendingPortions}` : '—'}
          tone={summary.pendingPortions > 0 ? 'warning' : 'neutral'}
          hint={summary.pendingPortions > 0 ? 'Могут прибавиться к плану' : 'Все подтверждены'}
        />
      </div>

      {/* Предупреждение про PENDING */}
      {summary.pendingPortions > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/20 bg-warning-bg/40 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-fg" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-warning-fg">
              На эту дату ещё {formatPortions(summary.pendingPortions)} ждут подтверждения
            </p>
            <p className="mt-0.5 text-xs text-warning-fg/80">
              Эти заказы могут увеличить потребности после ввода менеджером. Дождитесь подтверждений к 16:00.
            </p>
          </div>
        </div>
      )}

      {/* Предупреждение про отсутствующее меню */}
      {!summary.hasMenu && summary.totalPortions > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/20 bg-danger-bg/40 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger-fg" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-danger-fg">
              Меню на эту дату не утверждено
            </p>
            <p className="mt-0.5 text-xs text-danger-fg/80">
              Заказы есть ({formatPortions(summary.totalPortions)}), но непонятно какие блюда готовить. Утвердите меню в разделе «Меню».
            </p>
          </div>
        </div>
      )}

      {/* Табы Блюда / Сырьё */}
      <SegmentedControl<'dishes' | 'ingredients'>
        ariaLabel="Вид производства"
        className="w-fit"
        value={tab}
        onChange={(next) => {
          // dishes — дефолт, убираем из URL; ingredients — пишем в URL
          updateParams({ tab: next === 'dishes' ? null : 'ingredients' })
        }}
        options={[
          { value: 'dishes', label: 'Блюда' },
          { value: 'ingredients', label: 'Сырьё' },
        ]}
      />

      {/* Контент */}
      {tab === 'dishes' && <DishesTab summary={summary} canSeePrices={canSeePrices} />}
      {tab === 'ingredients' && <IngredientsTab summary={ingredientsSummary} canSeePrices={canSeePrices} />}
    </div>
  )
}

function DishesTab({ summary, canSeePrices }: { summary: ProductionSummary; canSeePrices: boolean }) {
  const hasAnyOrders = summary.totalPortions > 0
  if (!hasAnyOrders) {
    return (
      <EmptyState
        icon={ChefHat}
        title="На эту дату нет активных заказов"
        description="Производство не требуется."
      />
    )
  }

  return (
    <div className="space-y-6">
      {MEAL_TYPE_ORDER.map((mt) => {
        const data = summary.mealTypes[mt]
        if (data.totalPortions === 0) return null

        return (
          <section key={mt} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold text-fg">
                {MEAL_TYPE_LABELS[mt]}
                <span className="ml-2 text-sm font-normal text-fg-muted">
                  · {formatPortions(data.totalPortions)}
                </span>
              </h2>
              {!data.menuApproved && data.totalPortions > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-danger-fg">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  Меню не утверждено
                </span>
              )}
            </div>

            {data.dishes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface-2/40 p-6 text-center text-sm text-fg-muted">
                Меню для этого типа питания не задано или не утверждено
              </div>
            ) : (
              <div className="space-y-4">
                {/* Группируем блюда по slot category для красивой подачи */}
                {groupByCategory(data.dishes).map((group) => (
                  <div key={group.category} className="space-y-2">
                    <p className="text-[11px] font-medium uppercase tracking-widest text-fg-muted">
                      {DISH_CATEGORY_LABELS[group.category as DishCategory]}
                    </p>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {group.dishes.map((dish, dishIdx) => (
                        <div
                          key={dish.dishId + '-' + dishIdx}
                          className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4"
                          style={{ boxShadow: 'var(--shadow-card)' }}
                        >
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-lg" aria-hidden>
                            {DISH_CATEGORY_ICONS[dish.category as DishCategory]}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-fg">{dish.dishName}</div>
                            <div className="text-xs text-fg-muted">
                              {DISH_CATEGORY_LABELS[dish.category as DishCategory]}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="font-display text-2xl font-extrabold tabular-nums text-fg-strong">
                              {dish.totalPortions}
                            </div>
                            <div className="text-xs text-fg-muted">порций</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="flex items-center gap-1.5 px-1 text-xs text-fg-subtle">
                  <Info className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatOrders(data.dishes[0]?.ordersCount ?? 0)} · {formatLocations(data.dishes[0]?.locationsCount ?? 0)}
                  {canSeePrices && ` · сумма ${formatMoney(data.totalRevenue)}`}
                </p>
              </div>
            )}
          </section>
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
    warning: 'bg-warning-bg/40 border-warning/20',
    info: 'bg-info-bg/40 border-info/20',
  }
  return (
    <div
      className={cn('rounded-xl border p-4', toneClasses[tone])}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <p className="truncate text-[11px] font-medium uppercase tracking-widest text-fg-muted">
        {label}
      </p>
      <p className="mt-1.5 font-display text-2xl font-extrabold tabular-nums text-fg-strong lg:text-3xl">
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-xs text-fg-subtle">{hint}</p>}
    </div>
  )
}


function IngredientsTab({ summary, canSeePrices }: { summary: IngredientsSummary; canSeePrices: boolean }) {
  if (!summary.hasMenu) {
    return (
      <EmptyState
        icon={Wheat}
        title="Меню не утверждено"
        description="Без утверждённого меню невозможно посчитать потребности по сырью."
      />
    )
  }

  if (summary.rows.length === 0) {
    return (
      <EmptyState
        icon={Wheat}
        title="Нет потребностей в сырье"
        description="На эту дату не нашлось активных заказов или блюд с тех. картами."
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Маржа сверху */}
      {canSeePrices && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
      )}

      {/* Таблица ингредиентов */}
      <div className="overflow-hidden rounded-xl border border-border bg-surface" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2/50 text-[11px] uppercase tracking-widest text-fg-muted">
              <tr>
                {canSeePrices && <th className="w-10 px-4 py-3 text-left font-medium"></th>}
                <th className="px-3 py-3 text-left font-medium">Ингредиент</th>
                <th className="px-3 py-3 text-right font-medium">Нужно</th>
                {canSeePrices && <th className="hidden px-3 py-3 text-right font-medium md:table-cell">Цена</th>}
                {canSeePrices && <th className="px-3 py-3 text-right font-medium">Стоимость</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.rows.map((row) => (
                <IngredientRow key={row.ingredientId} row={row} canSeePrices={canSeePrices} />
              ))}
            </tbody>
            {canSeePrices && (
              <tfoot>
                <tr className="border-t-2 border-border bg-surface-2/40">
                  <td colSpan={4} className="px-4 py-3 text-right text-sm font-semibold text-fg">
                    Итого закупка:
                  </td>
                  <td className="px-3 py-3 text-right font-display text-base font-extrabold tabular-nums text-fg-strong">
                    {formatMoney(summary.totalCost)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="text-center text-xs text-fg-subtle">
        * Расчёт по тех. картам блюд (брутто).{canSeePrices && ' Цены из последней записи в справочнике сырья.'}
      </p>
    </div>
  )
}

function IngredientRow({ row, canSeePrices }: { row: IngredientProductionRow; canSeePrices: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const unitLabel = row.unit === 'KG' ? 'кг' : row.unit === 'L' ? 'л' : 'шт'
  const totalCols = 2 + (canSeePrices ? 3 : 0)

  function formatAmount(value: number): string {
    if (row.unit === 'PCS') return Math.ceil(value).toString()
    return value.toFixed(2)
  }

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-surface-2/40"
        onClick={() => setExpanded((v) => !v)}
      >
        {canSeePrices && (
          <td className="px-4 py-3 text-fg-subtle">
            {expanded ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          </td>
        )}
        <td className="px-3 py-3 font-medium text-fg">{row.ingredientName}</td>
        <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
          {formatAmount(row.totalNeeded)} {unitLabel}
        </td>
        {canSeePrices && (
          <td className="hidden whitespace-nowrap px-3 py-3 text-right tabular-nums text-fg-muted md:table-cell">
            {formatMoney(row.pricePerUnit)} / {unitLabel}
          </td>
        )}
        {canSeePrices && (
          <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-fg">
            {formatMoney(row.totalCost)}
          </td>
        )}
      </tr>
      {expanded && canSeePrices && (
        <tr className="bg-surface-2/30">
          <td colSpan={totalCols} className="px-12 py-3">
            <p className="mb-2 text-[11px] uppercase tracking-widest text-fg-subtle">
              Используется в блюдах
            </p>
            <ul className="space-y-1.5 text-xs">
              {row.usages.map((u, idx) => (
                <li key={u.dishId + '-' + idx} className="flex items-baseline justify-between gap-3">
                  <span className="text-fg">
                    <span className="font-medium">{u.dishName}</span>
                    <span className="ml-2 text-fg-muted">
                      {u.bruttoPerPortion} {u.unit === 'PCS' ? 'шт' : 'г'} × {formatPortions(u.portions)}
                    </span>
                  </span>
                  <span className="whitespace-nowrap tabular-nums text-fg-muted">
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
