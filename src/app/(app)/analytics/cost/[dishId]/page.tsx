import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { ChartCard } from '@/components/charts/chart-card'
import { RevenueLineChart } from '@/components/charts/revenue-line-chart'
import { requireRole } from '@/lib/auth/current-user'
import {
  getDishCostNow,
  getDishCostHistory,
  getDishUsageInMealSets,
} from '@/lib/db/queries/dish-cost'
import { DISH_CATEGORY_LABELS } from '@/lib/constants/dish-categories'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { INGREDIENT_UNIT_LABELS } from '@/lib/constants/dish-categories'
import { formatMoneyRu } from '@/lib/digest/format'
import { formatDateMsk } from '@/lib/utils/format'
import { marginTone, MARGIN_TONE_CLASSES } from '@/lib/utils/margin-color'
import { cn } from '@/lib/utils/cn'

const HISTORY_DAYS = 90
const RECENT_CHANGES_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

interface PageProps {
  params: Promise<{ dishId: string }>
}

export default async function DishCostDetailPage({ params }: PageProps) {
  await requireRole(['ADMIN'])
  const { dishId } = await params

  const now = new Date()
  const historyFrom = new Date(now.getTime() - HISTORY_DAYS * DAY_MS)

  const [dish, usage, history] = await Promise.all([
    getDishCostNow(dishId),
    getDishUsageInMealSets(dishId),
    getDishCostHistory(dishId, historyFrom, now),
  ])

  if (!dish) notFound()

  // Уникальные mealType из usage — где блюдо реально используется.
  const usedMealTypes = Array.from(new Set(usage.map((u) => u.mealType)))

  // Маржа и growth — из самого DishCostResult (после bulkEnrichDishMetrics).
  // Работает для ЛЮБОГО блюда, не только top-2 extremes.
  const marginRub = dish.marginRub
  const marginPct = dish.marginPercent
  const costGrowth30dPct = dish.growth30dPercent

  // Точки графика — из history.costPerPortion. Если null встречается в середине,
  // он останется 0 (RevenueLineChart строит непрерывную линию).
  const chartData = history.map((p) => ({
    label: formatDateMsk(p.date),
    value: p.costPerPortion ?? 0,
  }))

  // Раскладка — сортируем по убыванию вклада в себестоимость.
  const breakdownSorted = [...dish.breakdown].sort((a, b) => b.costContribution - a.costContribution)
  const breakdownTotal = breakdownSorted.reduce((s, b) => s + b.costContribution, 0)

  // Последние изменения цен ингредиентов за 30д — фильтруем history,
  // отсортированный от свежих к старым.
  const recentCutoff = new Date(now.getTime() - RECENT_CHANGES_DAYS * DAY_MS)
  const recentChanges = history
    .filter((p) => p.date >= recentCutoff)
    .slice()
    .reverse()

  const tone = marginTone(marginPct)

  return (
    <>
      <div className="mb-3">
        <Link
          href="/analytics/cost"
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К списку
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{dish.dishName}</h1>
        <div className="mt-2 inline-flex items-center gap-2 flex-wrap">
          <span className="text-xs px-2 py-0.5 rounded-pill bg-bg text-fg-muted">
            {DISH_CATEGORY_LABELS[dish.category]}
          </span>
          {usedMealTypes.map((mt) => (
            <span
              key={mt}
              className="text-xs px-2 py-0.5 rounded-pill bg-info-bg/40 text-info-fg"
            >
              {MEAL_TYPE_LABELS[mt]}
            </span>
          ))}
          {dish.hasPlaceholderPrices && (
            <span className="text-xs px-2 py-0.5 rounded-pill bg-warning-bg/30 text-warning-fg inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Есть placeholder-цены
            </span>
          )}
        </div>
      </div>

      {/* KPI ряд */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label="Текущая себестоимость"
          value={dish.costPerPortion !== null ? formatMoneyRu(dish.costPerPortion) : '—'}
          hint={
            dish.portionSize ? `на ${dish.portionSize} г/мл / порция` : 'portionSize не задан'
          }
        />
        <KpiCard
          label="Маржа ₽"
          value={marginRub !== null ? formatMoneyRu(marginRub) : '—'}
        />
        <KpiCard
          label="Маржа %"
          value={
            marginPct !== null ? (
              <span
                className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-pill text-base font-bold tabular-nums',
                  MARGIN_TONE_CLASSES[tone]
                )}
              >
                {marginPct}%
              </span>
            ) : (
              '—'
            )
          }
        />
        <KpiCard
          label="Изменение за 30д"
          value={
            costGrowth30dPct !== null ? (
              <span
                className={cn(
                  'inline-flex items-center gap-1',
                  costGrowth30dPct > 0
                    ? 'text-danger-fg'
                    : costGrowth30dPct < 0
                      ? 'text-success-fg'
                      : 'text-fg-muted'
                )}
              >
                {costGrowth30dPct > 0 ? (
                  <TrendingUp className="w-4 h-4" />
                ) : costGrowth30dPct < 0 ? (
                  <TrendingDown className="w-4 h-4" />
                ) : (
                  <Minus className="w-4 h-4" />
                )}
                {costGrowth30dPct > 0 ? '+' : ''}
                {costGrowth30dPct}%
              </span>
            ) : (
              '—'
            )
          }
        />
      </div>

      {/* График динамики */}
      <div className="mb-6">
        <ChartCard title="Динамика себестоимости" subtitle="За 90 дней" height="md">
          <RevenueLineChart
            data={chartData}
            formatValue={formatMoneyRu}
            emptyMessage="Нет изменений цен ингредиентов"
          />
        </ChartCard>
      </div>

      {/* Раскладка по ингредиентам */}
      <div className="mb-6">
        <div
          className="rounded-2xl bg-surface border border-border overflow-hidden"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold">Раскладка по ингредиентам</h3>
            <p className="text-xs text-fg-muted mt-0.5">
              На одну базовую единицу блюда
            </p>
          </div>
          {breakdownSorted.length === 0 ? (
            <div className="p-6 text-sm text-fg-muted text-center">
              В техкарте нет ингредиентов
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg/50">
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Ингредиент
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Брутто
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Цена за единицу
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Вклад ₽
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {breakdownSorted.map((b) => (
                    <tr key={b.ingredientId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">{b.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {formatBrutto(b.bruttoGrams, b.unit)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {formatMoneyRu(b.pricePerUnit)} / {INGREDIENT_UNIT_LABELS[b.unit]}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium">
                        {formatMoneyRu(b.costContribution)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-bg/50">
                    <td colSpan={3} className="px-4 py-2.5 text-right text-xs font-medium text-fg-muted uppercase tracking-wider">
                      Итого
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-bold whitespace-nowrap">
                      {formatMoneyRu(breakdownTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* В каких меню используется */}
      <div className="mb-6">
        <div
          className="rounded-2xl bg-surface border border-border overflow-hidden"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-sm font-semibold">В каких меню используется</h3>
          </div>
          {usage.length === 0 ? (
            <div className="p-6 text-sm text-fg-muted text-center">
              Не используется в активных меню
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg/50">
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Набор
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Приём пищи
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Слот
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Кол-во
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.mealSetId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-medium">{u.mealSetName}</td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs px-2 py-0.5 rounded-pill bg-info-bg/40 text-info-fg">
                          {MEAL_TYPE_LABELS[u.mealType]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs px-2 py-0.5 rounded-pill bg-bg text-fg-muted">
                          {DISH_CATEGORY_LABELS[u.slotCategory]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{u.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Последние изменения цен ингредиентов */}
      {recentChanges.length > 0 && (
        <div className="mb-6">
          <div
            className="rounded-2xl bg-surface border border-border overflow-hidden"
            style={{ boxShadow: 'var(--shadow-card)' }}
          >
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold">Последние изменения цен (30д)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg/50">
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Дата
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider">
                      Ингредиент
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Было → Стало
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                      Новая себест.
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentChanges.map((p, i) => (
                    <tr key={`${p.changedIngredient.id}-${i}`} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 whitespace-nowrap text-fg-muted">
                        {formatDateMsk(p.date)}
                      </td>
                      <td className="px-4 py-2.5">{p.changedIngredient.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                        <span className="text-fg-muted">{formatMoneyRu(p.changedIngredient.oldPrice)}</span>
                        <span className="mx-1 text-fg-subtle">→</span>
                        <span>{formatMoneyRu(p.changedIngredient.newPrice)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium">
                        {p.costPerPortion !== null ? formatMoneyRu(p.costPerPortion) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div
      className="rounded-2xl bg-surface border border-border p-4"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <p className="text-xs text-fg-muted">{label}</p>
      <div className="text-2xl font-bold tabular-nums tracking-tight mt-1">{value}</div>
      {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
    </div>
  )
}

function formatBrutto(grams: number, unit: 'KG' | 'L' | 'PCS'): string {
  if (unit === 'PCS') {
    return `${Math.round(grams).toLocaleString('ru-RU')} шт`
  }
  // KG/L: bruttoGrams в граммах/мл, показываем в кг/л с одной цифрой после запятой.
  const kg = grams / 1000
  const label = unit === 'KG' ? 'кг' : 'л'
  return `${kg.toFixed(3).replace('.', ',')} ${label}`
}
