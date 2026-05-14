'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, CalendarDays, Plus, Check } from 'lucide-react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/ui/status-badge'
import { DayEditor } from './day-editor'
import { createDraftMenu, approveMenu, unapproveMenu } from './actions'
import {
  formatWeekRange,
  shiftWeek,
  isCurrentWeek,
  WEEKDAY_NAMES_SHORT,
  WEEKDAY_NAMES_FULL,
  getDateForDayOfWeek,
} from '@/lib/utils/week'
import { MENU_STATUS_LABELS, MENU_STATUS_VARIANT } from '@/lib/constants/menu-status'
import { DISH_CATEGORY_ICONS } from '@/lib/constants/dish-categories'
import { cn } from '@/lib/utils/cn'
import type { Dish, MealType, DishCategory, UserRole } from '@prisma/client'

const MEAL_TYPE_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

interface MenuDayDish {
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
  mealType: MealType
  mealSet: {
    id: string
    name: string
    items: MealSetItemData[]
  } | null
  dishes: MenuDayDish[]
}

interface MenuData {
  id: string
  name: string
  validFrom: Date
  validTo: Date
  status: 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  approvedAt: Date | null
  approvedBy: { id: string; name: string } | null
  days: MenuDayData[]
}

interface Props {
  weekStartIso: string
  menu: MenuData | null
  dishes: Dish[]
  userRole: UserRole
}

export function MenuView({ weekStartIso, menu, dishes, userRole }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editingDay, setEditingDay] = useState<MenuDayData | null>(null)

  const monday = new Date(weekStartIso)
  const isCurrent = isCurrentWeek(monday)
  const canEdit = userRole === 'ADMIN' || userRole === 'CHEF'
  const canApprove = userRole === 'ADMIN'

  function navigateWeek(weeks: number) {
    const newWeek = shiftWeek(monday, weeks)
    router.push(`/menu?week=${newWeek.toISOString()}`)
  }

  function navigateToToday() {
    router.push('/menu')
  }

  function handleCreateDraft() {
    startTransition(async () => {
      const result = await createDraftMenu(monday.toISOString())
      if (result.ok) {
        toast.success('Черновик меню создан')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleApprove() {
    if (!menu) return
    startTransition(async () => {
      const result = await approveMenu(menu.id)
      if (result.ok) {
        toast.success('Меню утверждено')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleUnapprove() {
    if (!menu) return
    startTransition(async () => {
      const result = await unapproveMenu(menu.id)
      if (result.ok) {
        toast.success('Утверждение отозвано')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  // Группируем дни по dayOfWeek
  const daysByDow = new Map<number, Map<MealType, MenuDayData>>()
  if (menu) {
    for (const day of menu.days) {
      if (!daysByDow.has(day.dayOfWeek)) {
        daysByDow.set(day.dayOfWeek, new Map())
      }
      daysByDow.get(day.dayOfWeek)!.set(day.mealType, day)
    }
  }

  return (
    <div className="space-y-5">
      {/* Шапка недели */}
      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateWeek(-1)}
              aria-label="Предыдущая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <div className="px-3">
              <p className="font-semibold text-base">
                {formatWeekRange(monday)}
              </p>
              {menu && (
                <p className="text-xs text-fg-muted">{menu.name}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => navigateWeek(1)}
              aria-label="Следующая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            {!isCurrent && (
              <button
                type="button"
                onClick={navigateToToday}
                className="ml-2 px-3 py-1.5 rounded-pill bg-bg hover:bg-border text-fg-muted hover:text-fg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <CalendarDays className="w-3.5 h-3.5" />
                Текущая
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {menu && (
              <StatusBadge variant={MENU_STATUS_VARIANT[menu.status]}>
                {MENU_STATUS_LABELS[menu.status]}
              </StatusBadge>
            )}

            {menu?.approvedBy && menu.status === 'APPROVED' && (
              <span className="text-xs text-fg-muted">
                Утвердил: {menu.approvedBy.name}
              </span>
            )}

            {/* Кнопка «Создать меню» переехала внутрь EmptyState (см. ниже),
                чтобы CTA был в визуальном центре пустого экрана. */}

            {menu?.status === 'DRAFT' && canApprove && (
              <button
                type="button"
                onClick={handleApprove}
                disabled={isPending}
                className="px-4 py-2 rounded-pill bg-success text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2 disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                Утвердить
              </button>
            )}

            {menu?.status === 'APPROVED' && canApprove && (
              <button
                type="button"
                onClick={handleUnapprove}
                disabled={isPending}
                className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg-muted hover:text-fg hover:bg-bg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                Отозвать
              </button>
            )}

            {/* TODO: восстановить в Спринте 9 — AI-помощник для меню. Кнопка скрыта,
                чтобы не вводить менеджеров в заблуждение заглушкой. */}
          </div>
        </div>
      </div>

      {/* Сетка меню */}
      {!menu ? (
        <EmptyState canCreate={canEdit} onCreate={handleCreateDraft} isPending={isPending} />
      ) : (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-bg/50">
                  <th className="text-left px-3 py-3 text-xs uppercase tracking-wider text-fg-muted font-medium w-32">
                    День
                  </th>
                  {MEAL_TYPE_ORDER.map((mt) => (
                    <th key={mt} className="text-left px-3 py-3 text-xs uppercase tracking-wider text-fg-muted font-medium">
                      {MEAL_TYPE_LABELS[mt]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[1, 2, 3, 4, 5, 6, 7].map((dow) => {
                  const dayDate = getDateForDayOfWeek(monday, dow)
                  const isToday = dayDate.toDateString() === new Date().toDateString()

                  return (
                    <tr key={dow} className={cn(isToday && 'bg-warning-bg/20')}>
                      <td className="px-3 py-4 align-top">
                        <div className="font-semibold">{WEEKDAY_NAMES_SHORT[dow]}</div>
                        <div className="text-xs text-fg-muted">
                          {dayDate.getDate()}.{(dayDate.getMonth() + 1).toString().padStart(2, '0')}
                        </div>
                      </td>
                      {MEAL_TYPE_ORDER.map((mt) => {
                        const day = daysByDow.get(dow)?.get(mt)
                        return (
                          <td key={mt} className="px-3 py-3 align-top min-w-[200px]">
                            <DaySlotCell
                              day={day}
                              canEdit={canEdit && menu.status === 'DRAFT'}
                              onEdit={() => day && setEditingDay(day)}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Редактор дня (модалка) */}
      {editingDay && (
        <DayEditor
          day={editingDay}
          dishes={dishes}
          dayLabel={`${WEEKDAY_NAMES_FULL[editingDay.dayOfWeek]} · ${MEAL_TYPE_LABELS[editingDay.mealType]}`}
          onClose={() => setEditingDay(null)}
          onSaved={() => {
            setEditingDay(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function DaySlotCell({
  day,
  canEdit,
  onEdit,
}: {
  day: MenuDayData | undefined
  canEdit: boolean
  onEdit: () => void
}) {
  if (!day) {
    return <div className="text-xs text-fg-subtle">—</div>
  }

  if (day.dishes.length === 0) {
    return (
      <button
        type="button"
        onClick={onEdit}
        disabled={!canEdit}
        className={cn(
          'w-full text-left px-3 py-2.5 rounded-xl border border-dashed transition-colors text-xs',
          canEdit
            ? 'border-border-strong text-fg-muted hover:border-fg-muted hover:text-fg cursor-pointer'
            : 'border-border text-fg-subtle cursor-default'
        )}
      >
        {canEdit ? '+ Добавить блюда' : 'Не задано'}
      </button>
    )
  }

  // Группируем по slotCategory для вывода
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={!canEdit}
      className={cn(
        'w-full text-left rounded-xl p-2 transition-colors',
        canEdit ? 'hover:bg-bg/50 cursor-pointer' : 'cursor-default'
      )}
    >
      <ul className="space-y-1">
        {day.dishes.map((d) => (
          <li key={d.id} className="flex items-baseline gap-1.5 text-xs">
            <span aria-hidden className="shrink-0">{DISH_CATEGORY_ICONS[d.slotCategory]}</span>
            <span className="truncate">{d.dish.name}</span>
          </li>
        ))}
      </ul>
    </button>
  )
}

function EmptyState({
  canCreate,
  onCreate,
  isPending,
}: {
  canCreate: boolean
  onCreate: () => void
  isPending: boolean
}) {
  return (
    <div
      className="w-full rounded-3xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center min-h-[400px]"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <CalendarDays className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
      <p className="font-medium text-fg mb-1">Меню на эту неделю не создано</p>
      <p className="text-sm text-fg-muted max-w-sm mb-5">
        {canCreate
          ? 'Создайте черновик меню — вы сможете заполнить его блюдами и отправить на утверждение.'
          : 'Шеф ещё не создал меню на эту неделю.'}
      </p>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {isPending ? 'Создаём…' : 'Создать меню'}
        </button>
      )}
    </div>
  )
}
