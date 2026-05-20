'use client'

import type { DishCategory, MealType } from '@prisma/client'
import { WEEKDAY_NAMES_FULL } from '@/lib/utils/week'
import { MEAL_TYPE_LABELS, CORRECTION_LEVEL_COLORS } from '@/lib/menu-import/category-labels'
import { cn } from '@/lib/utils/cn'

export interface SerializedCycle {
  id: string
  name: string
  validFrom: Date
  validTo: Date
  days: Array<{
    id: string
    dayOfWeek: number
    mealType: MealType
    dishes: Array<{
      id: string
      slotCategory: DishCategory
      dish: {
        id: string
        name: string
        correctedName: string | null
        category: DishCategory
        correctionLevel: string | null
      }
    }>
  }>
}

interface Props {
  cycles: SerializedCycle[]
  onDishClick: (dishId: string) => void
}

export function MenuTreeView({ cycles, onDishClick }: Props) {
  if (cycles.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-fg-muted">
        Импорт не содержит расписания меню.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {cycles.map((cycle, idx) => (
        <CycleSection key={cycle.id} cycle={cycle} weekNumber={idx + 1} onDishClick={onDishClick} />
      ))}
    </div>
  )
}

function CycleSection({
  cycle,
  weekNumber,
  onDishClick,
}: {
  cycle: SerializedCycle
  weekNumber: number
  onDishClick: (dishId: string) => void
}) {
  // Группировка: dayOfWeek → MealType → dishes[]
  const grouped = new Map<number, Map<MealType, SerializedCycle['days'][number]>>()
  for (const day of cycle.days) {
    if (!grouped.has(day.dayOfWeek)) grouped.set(day.dayOfWeek, new Map())
    grouped.get(day.dayOfWeek)!.set(day.mealType, day)
  }
  const dows = Array.from(grouped.keys()).sort((a, b) => a - b)
  const totalDishes = cycle.days.reduce((acc, d) => acc + d.dishes.length, 0)

  return (
    <section
      className="bg-surface border border-border rounded-2xl p-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <header className="flex items-baseline gap-3 mb-4">
        <h2 className="text-lg font-semibold text-fg">Неделя {weekNumber}</h2>
        <span className="text-xs text-fg-subtle">
          {dows.length} {pluralDay(dows.length)} · {totalDishes} {pluralDish(totalDishes)}
        </span>
      </header>

      <div className="space-y-4">
        {dows.map((dow) => {
          const meals = grouped.get(dow)!
          const mealTypes = Array.from(meals.keys()).sort(mealOrder)
          return (
            <div key={dow}>
              <p className="text-sm font-medium text-fg mb-2">{WEEKDAY_NAMES_FULL[dow]}</p>
              <div className="space-y-2 pl-4">
                {mealTypes.map((mt) => {
                  const day = meals.get(mt)!
                  return (
                    <div key={mt} className="flex items-start gap-3">
                      <span className="text-xs text-fg-subtle w-12 shrink-0 mt-1">
                        {MEAL_TYPE_LABELS[mt]}
                      </span>
                      <div className="flex flex-wrap gap-1.5 flex-1">
                        {day.dishes.length === 0 ? (
                          <span className="text-xs text-fg-subtle italic">пусто</span>
                        ) : (
                          day.dishes.map((mdd) => (
                            <DishChip
                              key={mdd.id}
                              name={mdd.dish.correctedName ?? mdd.dish.name}
                              level={mdd.dish.correctionLevel}
                              onClick={() => onDishClick(mdd.dish.id)}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function DishChip({
  name,
  level,
  onClick,
}: {
  name: string
  level: string | null
  onClick: () => void
}) {
  const color = level ? CORRECTION_LEVEL_COLORS[level] : undefined
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
        'text-xs text-fg bg-fg/5 hover:bg-fg/10 transition-colors'
      )}
    >
      {color && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-label="AI правка"
        />
      )}
      <span>{name}</span>
    </button>
  )
}

function mealOrder(a: MealType, b: MealType): number {
  const order: Record<MealType, number> = { BREAKFAST: 0, LUNCH: 1, DINNER: 2 }
  return order[a] - order[b]
}

function pluralDay(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'день'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'дня'
  return 'дней'
}

function pluralDish(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'блюдо'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'блюда'
  return 'блюд'
}
