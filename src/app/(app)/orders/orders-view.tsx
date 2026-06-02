'use client'

import { useState, useTransition, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight, MoreVertical } from 'lucide-react'
import { toast } from 'sonner'
import { OrdersList } from './orders-list'
import { OrdersWeek } from './orders-week'
import { regenerateFixedOrders } from './actions'
import { formatDateShort } from '@/lib/utils/format'
import { toMskDateString, getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { formatWeekRange, shiftWeek, isCurrentWeek } from '@/lib/utils/week'
import { cn } from '@/lib/utils/cn'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { Order, Client, ClientLocation } from '@prisma/client'

type SerializedListOrder = Omit<Order, 'pricePerPortion' | 'totalPrice' | 'vatRate'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
  delivery: { issueReportedAt: Date | string | null } | null
}

type SerializedWeekOrder = Omit<Order, 'pricePerPortion' | 'totalPrice' | 'vatRate'> & {
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
      updateParams({ view: 'list', date: toMskDateString(selectedDate), weekStart: null })
    }
  }

  function shiftDate(days: number) {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    updateParams({ date: toMskDateString(d) })
  }

  function shiftWeekDate(weeks: number) {
    if (!weekStart) return
    const newWeek = shiftWeek(weekStart, weeks)
    updateParams({ weekStart: newWeek.toISOString() })
  }

  // 7.43: сравниваем МСК-календарные дни строкой (toMskDateString), а не getTime()
  // двух дат. Раньше selectedDate (UTC-полночь @db.Date) сравнивался с
  // new Date()+setHours(0,0,0,0), который в МСК-браузере даёт МСК-полночь (UTC−3ч)
  // → getTime() никогда не совпадал → подсветка Сегодня/Завтра не загоралась.
  const isToday = useMemo(() => {
    return toMskDateString(selectedDate) === toMskDateString(new Date())
  }, [selectedDate])

  const isTomorrow = useMemo(() => {
    const tomorrowMsk = getMskCalendarDayUtc(new Date(), 1)
    return toMskDateString(selectedDate) === toMskDateString(tomorrowMsk)
  }, [selectedDate])

  function jumpToToday() {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    updateParams({ date: toMskDateString(d) })
  }

  function jumpToTomorrow() {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
    updateParams({ date: toMskDateString(d) })
  }

  return (
    <div className="space-y-5">
      {/* Единая панель управления: режим + навигация по датам.
          ServiceMenu (⋮) abs-positioned в правом верхнем углу карточки —
          не толкается DateNav'ом и не вылезает за край при wrap. pr-12 на
          основном flex даёт зазор справа под кнопку. */}
      <div
        className="relative rounded-2xl bg-surface border border-border p-3 pr-12 flex items-center gap-3 flex-wrap"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <SegmentedControl<'list' | 'week'>
          ariaLabel="Режим отображения"
          value={view}
          onChange={(next) => setView(next)}
          options={[
            { value: 'list', label: 'Список' },
            { value: 'week', label: 'Неделя' },
          ]}
        />

        {view === 'list' ? (
          <DateNav
            onPrev={() => shiftDate(-1)}
            onNext={() => shiftDate(1)}
            label={formatDateShort(selectedDate)}
            isToday={isToday}
            isTomorrow={isTomorrow}
            onJumpToday={jumpToToday}
            onJumpTomorrow={jumpToTomorrow}
          />
        ) : weekStart && (
          <WeekNav
            onPrev={() => shiftWeekDate(-1)}
            onNext={() => shiftWeekDate(1)}
            label={formatWeekRange(weekStart)}
            isCurrent={isCurrentWeek(weekStart)}
          />
        )}

        <div className="absolute top-3 right-3">
          <ServiceMenu />
        </div>
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

function DateNav({
  onPrev,
  onNext,
  label,
  isToday,
  isTomorrow,
  onJumpToday,
  onJumpTomorrow,
}: {
  onPrev: () => void
  onNext: () => void
  label: string
  isToday: boolean
  isTomorrow: boolean
  onJumpToday: () => void
  onJumpTomorrow: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Предыдущий день"
        className="w-9 h-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onJumpToday}
        className={cn(
          'px-3 py-2 sm:py-1.5 rounded-pill text-xs font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30',
          isToday ? 'bg-brand-green-light text-brand-green-deep' : 'text-fg-muted hover:text-fg hover:bg-surface-2'
        )}
      >
        Сегодня
      </button>
      <button
        type="button"
        onClick={onJumpTomorrow}
        className={cn(
          'px-3 py-2 sm:py-1.5 rounded-pill text-xs font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30',
          isTomorrow ? 'bg-brand-green-light text-brand-green-deep' : 'text-fg-muted hover:text-fg hover:bg-surface-2'
        )}
      >
        Завтра
      </button>
      <span className="px-2 text-sm text-fg-muted">·</span>
      <p className="font-semibold text-sm capitalize whitespace-nowrap">{label}</p>
      <button
        type="button"
        onClick={onNext}
        aria-label="Следующий день"
        className="w-9 h-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}

function WeekNav({
  onPrev,
  onNext,
  label,
  isCurrent,
}: {
  onPrev: () => void
  onNext: () => void
  label: string
  isCurrent: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onPrev}
        aria-label="Предыдущая неделя"
        className="w-9 h-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <div className="px-3">
        <p className="font-semibold text-sm whitespace-nowrap">{label}</p>
        {isCurrent && <p className="text-[10px] text-info-fg leading-none mt-0.5">Текущая</p>}
      </div>
      <button
        type="button"
        onClick={onNext}
        aria-label="Следующая неделя"
        className="w-9 h-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}


function ServiceMenu() {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleRegenerate() {
    setOpen(false)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)

    startTransition(async () => {
      const result = await regenerateFixedOrders(tomorrow.toISOString())
      if (result.ok) {
        const { created, skippedExisting, matchedSchedule, candidatesTotal } = result.data
        if (created > 0) {
          toast.success(`Создано: ${created}${skippedExisting > 0 ? ` · уже было: ${skippedExisting}` : ''}`)
        } else if (skippedExisting > 0) {
          toast(`Все ${skippedExisting} питаний уже имеют заказы на завтра`, { icon: '✓' })
        } else if (candidatesTotal === 0) {
          toast('Нет активного фиксированного питания', { icon: 'ℹ️' })
        } else {
          toast('Нет питания с расписанием на завтра', { icon: 'ℹ️' })
        }
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Сервисные действия"
        className="w-9 h-9 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-muted hover:text-fg transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-2 w-72 rounded-2xl bg-surface border border-border p-2 z-40"
            style={{ boxShadow: 'var(--shadow-popover)' }}
          >
            <div className="px-3 py-2 text-xs uppercase tracking-wider text-fg-subtle">
              Сервис
            </div>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={isPending}
              className="w-full text-left px-3 py-2 rounded-xl hover:bg-surface-2 transition-colors disabled:opacity-50 [touch-action:manipulation]"
            >
              <div className="text-sm font-medium">
                {isPending ? 'Генерируем…' : 'Сгенерировать заказы на завтра'}
              </div>
              <div className="text-xs text-fg-subtle mt-0.5">
                Обычно автоматически в 06:00. Кнопка нужна если автогенерация не сработала или вы только что добавили питание.
              </div>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
