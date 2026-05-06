'use client'

import { useState, useTransition, useMemo } from 'react'
import { X, Save } from 'lucide-react'
import { toast } from 'sonner'
import { saveDayDishes } from './actions'
import { DISH_CATEGORY_LABELS, DISH_CATEGORY_ICONS } from '@/lib/constants/dish-categories'
import { cn } from '@/lib/utils/cn'
import type { Dish, DishCategory } from '@prisma/client'

interface MenuDayDishItem {
  id: string
  dishId: string
  slotCategory: DishCategory
  dish: Dish
}

interface MealSetItemData {
  dishCategory: DishCategory
  quantity: number
}

interface MenuDayData {
  id: string
  dayOfWeek: number
  mealSet: {
    id: string
    name: string
    items: MealSetItemData[]
  } | null
  dishes: MenuDayDishItem[]
}

interface Props {
  day: MenuDayData
  dishes: Dish[]
  dayLabel: string
  onClose: () => void
  onSaved: () => void
}

interface SlotState {
  slotCategory: DishCategory
  dishId: string | null
}

export function DayEditor({ day, dishes, dayLabel, onClose, onSaved }: Props) {
  const [isPending, startTransition] = useTransition()

  // Список слотов из MealSet (или fallback — категории, которые есть в текущих dishes)
  const slots = useMemo<SlotState[]>(() => {
    const result: SlotState[] = []
    const currentByCategory = new Map<DishCategory, string[]>()

    for (const d of day.dishes) {
      if (!currentByCategory.has(d.slotCategory)) {
        currentByCategory.set(d.slotCategory, [])
      }
      currentByCategory.get(d.slotCategory)!.push(d.dishId)
    }

    if (day.mealSet) {
      // Раскрываем quantity: если суп = 1, добавляем один слот; если хлеб белый = 2, добавляем два
      for (const item of day.mealSet.items) {
        const used = currentByCategory.get(item.dishCategory) ?? []
        for (let i = 0; i < item.quantity; i++) {
          result.push({
            slotCategory: item.dishCategory,
            dishId: used[i] ?? null,
          })
        }
      }
    } else {
      // Fallback: только текущие
      for (const d of day.dishes) {
        result.push({
          slotCategory: d.slotCategory,
          dishId: d.dishId,
        })
      }
    }

    return result
  }, [day])

  const [slotStates, setSlotStates] = useState<SlotState[]>(slots)

  // Группируем блюда по категориям
  const dishesByCategory = useMemo(() => {
    const map = new Map<DishCategory, Dish[]>()
    for (const d of dishes) {
      if (!map.has(d.category)) {
        map.set(d.category, [])
      }
      map.get(d.category)!.push(d)
    }
    return map
  }, [dishes])

  function updateSlot(index: number, dishId: string | null) {
    setSlotStates((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], dishId }
      return next
    })
  }

  function handleSave() {
    const filled = slotStates
      .filter((s) => s.dishId)
      .map((s) => ({
        dishId: s.dishId!,
        slotCategory: s.slotCategory,
      }))

    startTransition(async () => {
      const result = await saveDayDishes(day.id, filled)
      if (result.ok) {
        toast.success('День сохранён')
        onSaved()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-surface border border-border" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">{dayLabel}</h2>
            <p className="text-xs text-fg-muted">
              {day.mealSet ? `Набор: ${day.mealSet.name}` : 'Без типового набора'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {slotStates.length === 0 ? (
            <p className="text-sm text-fg-muted text-center py-8">
              У этого набора нет слотов
            </p>
          ) : (
            slotStates.map((slot, i) => {
              const availableDishes = dishesByCategory.get(slot.slotCategory) ?? []
              const sameSlotIndices = slotStates
                .map((s, idx) => (s.slotCategory === slot.slotCategory ? idx : -1))
                .filter((idx) => idx !== -1)
              const slotNumber = sameSlotIndices.indexOf(i) + 1
              const totalInCategory = sameSlotIndices.length

              return (
                <div key={i} className="bg-bg/40 rounded-xl p-3">
                  <label className="flex items-center gap-2 text-sm font-medium mb-2">
                    <span aria-hidden>{DISH_CATEGORY_ICONS[slot.slotCategory]}</span>
                    {DISH_CATEGORY_LABELS[slot.slotCategory]}
                    {totalInCategory > 1 && (
                      <span className="text-xs text-fg-muted font-normal">
                        ({slotNumber} из {totalInCategory})
                      </span>
                    )}
                  </label>
                  <select
                    value={slot.dishId ?? ''}
                    onChange={(e) => updateSlot(i, e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm"
                  >
                    <option value="">— не выбрано —</option>
                    {availableDishes.length === 0 ? (
                      <option value="" disabled>
                        Нет блюд в категории «{DISH_CATEGORY_LABELS[slot.slotCategory]}»
                      </option>
                    ) : (
                      availableDishes.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )
            })
          )}
        </div>

        <div className="p-5 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {isPending ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
