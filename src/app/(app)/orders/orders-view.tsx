'use client'

import { useTransition, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { List, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { OrdersList } from './orders-list'
import { OrdersWeek } from './orders-week'
import { formatDateShort, formatDateNumeric } from '@/lib/utils/format'
import { formatWeekRange, shiftWeek, isCurrentWeek } from '@/lib/utils/week'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, ClientLocation } from '@prisma/client'

type SerializedListOrder = Omit<Order, 'pricePerPortion' | 'totalPrice'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
}

type SerializedWeekOrder = Omit<Order, 'pricePerPortion' | 'totalPrice'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
}

interface Props {
  view: 'list' | 'week'
  selectedDateIso: string
  weekStartIso: string | null
  listOrders: SerializedListOrder[] | null
  weekOrders: SerializedWeekOrder[] | null
  clients: Array<{ id: string; name: string }>
  filters: {
    clientId: string
    mealType: string
    status: string
    search: string
  }
}

export function OrdersView({
  view,
  selectedDateIso,
  weekStartIso,
  listOrders,
  weekOrders,
  clients,
  filters,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const selectedDate = new Date(selectedDateIso)
  const weekStart = weekStartIso ? new Date(weekStartIso) : null

  function updateParams(patch: Record<string, string | null | undefined>) {
    const url = new URL(window.location.href)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') {
        url.searchParams.delete(key)
      } else {
        url.searchParams.set(key, value)
      }
    }
    startTransition(() => {
      router.push(`${pathname}?${url.searchParams.toString()}`)
    })
  }

  function setView(newView: 'list' | 'week') {
    if (newView === 'week') {
      // При переключении в неделю используем понедельник недели текущей выбранной даты
      const monday = (() => {
        const d = new Date(selectedDate)
        const day = d.getDay()
        const diff = day === 0 ? -6 : 1 - day
        d.setDate(d.getDate() + diff)
        d.setHours(0, 0, 0, 0)
        return d
      })()
      updateParams({ view: 'week', weekStart: monday.toISOString(), date: null })
    } else {
      updateParams({ view: 'list', date: selectedDate.toISOString(), weekStart: null })
    }
  }

  function shiftDate(days: number) {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    updateParams({ date: d.toISOString() })
  }

  function shiftWeekDate(weeks: number) {
    if (!weekStart) return
    const newWeek = shiftWeek(weekStart, weeks)
    updateParams({ weekStart: newWeek.toISOString() })
  }

  const isToday = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return selectedDate.getTime() === today.getTime()
  }, [selectedDate])

  const isTomorrow = useMemo(() => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)
    return selectedDate.getTime() === tomorrow.getTime()
  }, [selectedDate])

  function jumpToToday() {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    updateParams({ date: d.toISOString() })
  }

  function jumpToTomorrow() {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
    updateParams({ date: d.toISOString() })
  }

  return (
    <div className="space-y-5">
      {/* Шапка с переключателем режимов и навигацией */}
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {/* Переключатель режимов */}
          <div className="flex gap-1 p-1 bg-bg rounded-pill">
            <ViewToggleButton active={view === 'list'} onClick={() => setView('list')} icon={List} label="Список" />
            <ViewToggleButton active={view === 'week'} onClick={() => setView('week')} icon={CalendarDays} label="Неделя" />
          </div>

          {/* Быстрые ссылки */}
          {view === 'list' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={jumpToToday}
                className={cn(
                  'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                  isToday ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
                )}
              >
                Сегодня
              </button>
              <button
                type="button"
                onClick={jumpToTomorrow}
                className={cn(
                  'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
                  isTomorrow ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
                )}
              >
                Завтра
              </button>
            </div>
          )}
        </div>

        {/* Навигация по дате/неделе */}
        {view === 'list' ? (
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
              <p className="font-semibold text-base capitalize">
                {formatDateShort(selectedDate)}
              </p>
              <p className="text-xs text-fg-muted">{formatDateNumeric(selectedDate)}</p>
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
        ) : weekStart && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => shiftWeekDate(-1)}
              aria-label="Предыдущая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-3 flex-1 text-center">
              <p className="font-semibold text-base">{formatWeekRange(weekStart)}</p>
              {isCurrentWeek(weekStart) && (
                <p className="text-xs text-info-fg">Текущая неделя</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => shiftWeekDate(1)}
              aria-label="Следующая неделя"
              className="w-9 h-9 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Контент режима */}
      {view === 'list' && listOrders && (
        <OrdersList
          orders={listOrders}
          clients={clients}
          filters={filters}
          onFilterChange={(patch) => updateParams(patch)}
          isPending={isPending}
        />
      )}

      {view === 'week' && weekOrders && weekStart && (
        <OrdersWeek
          orders={weekOrders}
          weekStart={weekStart}
        />
      )}
    </div>
  )
}

function ViewToggleButton({
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
