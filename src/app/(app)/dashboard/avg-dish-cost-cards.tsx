import Link from 'next/link'
import { TrendingUp, TrendingDown, Minus, ChevronRight } from 'lucide-react'
import type { MealType } from '@prisma/client'
import { getAvgDishCostPerPortion } from '@/lib/db/queries/dish-cost'
import { getPresetRange } from '@/lib/utils/week'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { formatMoneyRu } from '@/lib/digest/format'
import { cn } from '@/lib/utils/cn'

const MEAL_TYPES: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

/**
 * 3 виджета дашборда: средняя себестоимость порции по mealType
 * (Завтрак / Обед / Ужин) за текущую финансовую неделю с Δ% к прошлой неделе.
 *
 * ADMIN-only: guard у вызывающего (dashboard/page.tsx).
 *
 * 6 параллельных запросов (3 типа × current+prev) — getAvgDishCostPerPortion
 * сама агрегирует все блюда соответствующего mealType, учитывает только те,
 * у кого есть portionSize. Карточка ссылается на /analytics/cost?mealType=X.
 *
 * Семантика Δ: рост себестоимости — плохо (красный); падение — хорошо (зелёный).
 * В отличие от выручки в admin-week-block, где знак инвертирован.
 */
export async function AvgDishCostCards() {
  const currentRange = getPresetRange('this_week')
  const prevRange = getPresetRange('last_week')

  // Параллельно: для каждого mealType — current + prev → 6 запросов.
  const pairs = await Promise.all(
    MEAL_TYPES.map(async (mt) => {
      const [current, prev] = await Promise.all([
        getAvgDishCostPerPortion(currentRange.from, currentRange.to, mt),
        getAvgDishCostPerPortion(prevRange.from, prevRange.to, mt),
      ])
      return { mt, current, prev }
    })
  )

  return (
    <section className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">
        Средняя себестоимость порции
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {pairs.map(({ mt, current, prev }) => (
          <AvgDishCostCard key={mt} mealType={mt} current={current} prev={prev} />
        ))}
      </div>
    </section>
  )
}

type CostBucket = Awaited<ReturnType<typeof getAvgDishCostPerPortion>>

function AvgDishCostCard({
  mealType,
  current,
  prev,
}: {
  mealType: MealType
  current: CostBucket
  prev: CostBucket
}) {
  const value = current.avgPerPortion
  const prevValue = prev.avgPerPortion

  // Δ% по сравнению с прошлой неделей. null если хоть одна точка отсутствует
  // (или prev = 0 — деление на ноль).
  let deltaPct: number | null = null
  if (value !== null && prevValue !== null && prevValue > 0) {
    deltaPct = Math.round(((value - prevValue) / prevValue) * 1000) / 10
  }

  const isFlat = deltaPct !== null && Math.abs(deltaPct) < 0.1
  const isUp = deltaPct !== null && deltaPct > 0 && !isFlat
  const isDown = deltaPct !== null && deltaPct < 0 && !isFlat

  // Рост себестоимости плохой → красный; падение хорошее → зелёный.
  const deltaClasses = cn(
    'inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-xs font-medium',
    deltaPct === null && 'bg-bg text-fg-subtle',
    isFlat && 'bg-bg text-fg-muted',
    isUp && 'bg-danger-bg/40 text-danger-fg',
    isDown && 'bg-success-bg/40 text-success-fg'
  )

  return (
    <Link
      href={`/analytics/cost?mealType=${mealType}`}
      className="block rounded-2xl bg-surface border border-border p-5 transition-all hover:shadow-md group"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{MEAL_TYPE_LABELS[mealType]}</p>
        <ChevronRight className="w-4 h-4 text-fg-subtle group-hover:text-fg-muted group-hover:translate-x-0.5 transition-all" />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-3xl font-bold tracking-tight tabular-nums">
          {value !== null ? formatMoneyRu(value) : <span className="text-fg-subtle text-lg font-normal">нет данных</span>}
        </p>
        {deltaPct !== null && (
          <span className={deltaClasses}>
            {isFlat ? (
              <Minus className="w-3 h-3" />
            ) : isUp ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {isFlat ? '≈ 0%' : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`}
          </span>
        )}
      </div>

      <p className="text-xs text-fg-subtle mt-1">
        {current.dishesIncluded > 0
          ? `${current.dishesIncluded} ${pluralizeDishes(current.dishesIncluded)} · ${current.totalPortions} порц.`
          : 'Нет порций за период'}
      </p>

      {current.hasMissingPortionSize && (
        <p className="text-[11px] text-warning-fg mt-1.5">
          Есть блюда без указанного размера порции
        </p>
      )}
    </Link>
  )
}

function pluralizeDishes(n: number): string {
  const abs = Math.abs(n) % 100
  const lastDigit = abs % 10
  if (abs > 10 && abs < 20) return 'блюд'
  if (lastDigit === 1) return 'блюдо'
  if (lastDigit > 1 && lastDigit < 5) return 'блюда'
  return 'блюд'
}
