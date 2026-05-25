import Link from 'next/link'
import { AlertTriangle, TrendingUp, TrendingDown, Coins, BadgePercent, BadgeMinus, Flame, ChevronRight } from 'lucide-react'
import type { DishCategory, MealType } from '@prisma/client'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { getDishCostList } from '@/lib/db/queries/dish-cost'
import { getDishCostExtremes } from '@/lib/db/queries/dish-cost-extremes'
import { DISH_CATEGORY_LABELS, DISH_CATEGORY_ORDER } from '@/lib/constants/dish-categories'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { formatMoneyRu } from '@/lib/digest/format'
import { marginTone, MARGIN_TONE_CLASSES } from '@/lib/utils/margin-color'
import { cn } from '@/lib/utils/cn'

const MEAL_TYPES: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

// Тип-гард на enum-значения из URL — защита от случайных подделок.
function parseMealType(v: string | undefined): MealType | undefined {
  if (!v) return undefined
  return (MEAL_TYPES as string[]).includes(v) ? (v as MealType) : undefined
}

function parseCategory(v: string | undefined): DishCategory | undefined {
  if (!v) return undefined
  return (DISH_CATEGORY_ORDER as string[]).includes(v) ? (v as DishCategory) : undefined
}

interface PageProps {
  searchParams: Promise<{ category?: string; mealType?: string }>
}

export default async function CostPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN'])
  const params = await searchParams
  const mealType = parseMealType(params.mealType)
  const category = parseCategory(params.category)

  const [extremes, dishes] = await Promise.all([
    getDishCostExtremes(mealType),
    getDishCostList({ category, mealType }),
  ])

  return (
    <>
      <PageHeader
        title="Себестоимость блюд"
        subtitle="Сравнение себестоимости и маржи по блюдам"
      />

      {/* Топ-метрики */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <ExtremeCard
          icon={<Coins className="w-4 h-4" />}
          label="Самое дорогое"
          dish={extremes.mostExpensive}
          value={extremes.mostExpensive ? formatMoneyRu(extremes.mostExpensive.costPerPortion) : null}
        />
        <ExtremeCard
          icon={<BadgePercent className="w-4 h-4" />}
          label="Самая жирная маржа %"
          dish={extremes.thickestMarginPercent}
          value={
            extremes.thickestMarginPercent
              ? `${extremes.thickestMarginPercent.marginPercent}%`
              : null
          }
          valueTone="success"
        />
        <ExtremeCard
          icon={<BadgeMinus className="w-4 h-4" />}
          label="Самая тонкая маржа %"
          dish={extremes.thinnestMarginPercent}
          value={
            extremes.thinnestMarginPercent
              ? `${extremes.thinnestMarginPercent.marginPercent}%`
              : null
          }
          valueTone="danger"
        />
        <ExtremeCard
          icon={<Flame className="w-4 h-4" />}
          label="Подорожало больше всех (30д)"
          dish={extremes.biggestCostGrowthLastMonth}
          value={
            extremes.biggestCostGrowthLastMonth
              ? `${extremes.biggestCostGrowthLastMonth.percentGrowth > 0 ? '+' : ''}${extremes.biggestCostGrowthLastMonth.percentGrowth}%`
              : null
          }
          valueTone="warning"
        />
      </div>

      {/* Фильтры */}
      <div
        className="rounded-2xl bg-surface border border-border p-4 space-y-3 mb-4"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div>
          <p className="text-xs uppercase tracking-wider text-fg-muted font-medium mb-2">
            Тип приёма пищи
          </p>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={!mealType}
              href={buildHref({ category })}
              label="Все"
            />
            {MEAL_TYPES.map((mt) => (
              <FilterChip
                key={mt}
                active={mealType === mt}
                href={buildHref({ category, mealType: mt })}
                label={MEAL_TYPE_LABELS[mt]}
              />
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-fg-muted font-medium mb-2">
            Категория
          </p>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={!category}
              href={buildHref({ mealType })}
              label="Все категории"
            />
            {DISH_CATEGORY_ORDER.map((cat) => (
              <FilterChip
                key={cat}
                active={category === cat}
                href={buildHref({ category: cat, mealType })}
                label={DISH_CATEGORY_LABELS[cat]}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Таблица */}
      <div
        className="rounded-2xl bg-surface border border-border overflow-hidden"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        {dishes.length === 0 ? (
          <div className="p-8 text-center text-sm text-fg-muted">
            По выбранным фильтрам блюд не найдено
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg/50">
                  <th className="text-left px-4 py-3 font-medium text-fg-muted text-xs uppercase tracking-wider">
                    Блюдо
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                    Себест. порции
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                    Цена продажи
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-fg-muted text-xs uppercase tracking-wider">
                    Маржа %
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-fg-muted text-xs uppercase tracking-wider whitespace-nowrap">
                    Δ за 30д
                  </th>
                  <th className="w-8 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {dishes.map((d) => {
                  const tone = marginTone(d.marginPercent)

                  return (
                    <tr
                      key={d.dishId}
                      className="border-b border-border last:border-0 hover:bg-bg/50 transition-colors group"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/analytics/cost/${d.dishId}`}
                          className="flex items-center gap-2 min-w-0"
                        >
                          <span className="font-medium truncate">{d.dishName}</span>
                          <span className="text-xs px-2 py-0.5 rounded-pill bg-bg text-fg-muted shrink-0">
                            {DISH_CATEGORY_LABELS[d.category]}
                          </span>
                          {d.hasPlaceholderPrices && (
                            <span
                              className="shrink-0 inline-flex items-center"
                              title="В техкарте есть ингредиенты с placeholder-ценой — себестоимость приблизительная"
                            >
                              <AlertTriangle className="w-3.5 h-3.5 text-warning-fg" />
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {d.costPerPortion !== null ? (
                          formatMoneyRu(d.costPerPortion)
                        ) : (
                          <span
                            className="inline-flex items-center text-xs px-2 py-0.5 rounded-pill bg-warning-bg/30 text-warning-fg"
                            title="Установите portionSize для блюда"
                          >
                            нет данных о порции
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {d.sellPrice != null ? formatMoneyRu(d.sellPrice) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {d.marginPercent != null ? (
                          <span
                            className={cn(
                              'inline-flex items-center px-2 py-0.5 rounded-pill text-xs font-medium tabular-nums',
                              MARGIN_TONE_CLASSES[tone]
                            )}
                          >
                            {d.marginPercent}%
                          </span>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {d.growth30dPercent != null ? (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              d.growth30dPercent > 0
                                ? 'text-danger-fg'
                                : d.growth30dPercent < 0
                                  ? 'text-success-fg'
                                  : 'text-fg-muted'
                            )}
                          >
                            {d.growth30dPercent > 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : d.growth30dPercent < 0 ? (
                              <TrendingDown className="w-3 h-3" />
                            ) : null}
                            {d.growth30dPercent > 0 ? '+' : ''}
                            {d.growth30dPercent}%
                          </span>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/analytics/cost/${d.dishId}`}
                          aria-label="Открыть детали"
                          className="inline-flex"
                        >
                          <ChevronRight className="w-4 h-4 text-fg-subtle group-hover:text-fg-muted group-hover:translate-x-0.5 transition-all" />
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function buildHref(opts: { category?: DishCategory; mealType?: MealType }): string {
  const sp = new URLSearchParams()
  if (opts.category) sp.set('category', opts.category)
  if (opts.mealType) sp.set('mealType', opts.mealType)
  const qs = sp.toString()
  return qs ? `/analytics/cost?${qs}` : '/analytics/cost'
}

function FilterChip({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
        active ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
      )}
    >
      {label}
    </Link>
  )
}

type ExtremeDish = { dishId: string; dishName: string } | null

function ExtremeCard({
  icon,
  label,
  dish,
  value,
  valueTone,
}: {
  icon: React.ReactNode
  label: string
  dish: ExtremeDish
  value: string | null
  valueTone?: 'success' | 'danger' | 'warning'
}) {
  const valueClasses = cn(
    'text-2xl font-bold tabular-nums tracking-tight mt-1',
    valueTone === 'success' && 'text-success-fg',
    valueTone === 'danger' && 'text-danger-fg',
    valueTone === 'warning' && 'text-warning-fg'
  )

  const body = (
    <>
      <div className="flex items-center gap-1.5 text-fg-muted">
        <span className="shrink-0">{icon}</span>
        <p className="text-xs">{label}</p>
      </div>
      {dish && value ? (
        <>
          <p className={valueClasses}>{value}</p>
          <p className="text-xs text-fg-subtle truncate mt-0.5">{dish.dishName}</p>
        </>
      ) : (
        <p className="text-2xl font-bold text-fg-subtle mt-1">—</p>
      )}
    </>
  )

  if (dish) {
    return (
      <Link
        href={`/analytics/cost/${dish.dishId}`}
        className="block rounded-2xl bg-surface border border-border p-4 hover:shadow-md transition-all"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        {body}
      </Link>
    )
  }
  return (
    <div
      className="rounded-2xl bg-surface border border-border p-4"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {body}
    </div>
  )
}
