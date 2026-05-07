'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Check, MapPin, Phone, Clock, AlertTriangle, Tag, Package, Undo2, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { markStopDelivered, undoStopDelivered } from './actions'
import { formatDateShort, formatDateNumeric, formatDeliveryWindow } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS, PACKAGING_LABELS } from '@/lib/constants/client'
import type { DeliveryStop } from '@/lib/db/queries/deliveries'
import type { UserRole } from '@prisma/client'

interface Props {
  stops: DeliveryStop[]
  targetDateIso: string
  userRole: UserRole
}

export function DeliveryView({ stops, targetDateIso, userRole }: Props) {
  const router = useRouter()
  const [showDelivered, setShowDelivered] = useState(false)

  const targetDate = new Date(targetDateIso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const isToday = targetDate.getTime() === today.getTime()

  function shiftDate(days: number) {
    const d = new Date(targetDate)
    d.setDate(d.getDate() + days)
    router.push(`/delivery?date=${d.toISOString()}`)
  }

  function jumpToToday() {
    router.push('/delivery')
  }

  const activeStops = stops.filter((s) => !s.isDelivered)
  const deliveredStops = stops.filter((s) => s.isDelivered)
  const totalPortions = stops.reduce((s, x) => s + x.totalPortions, 0)
  const deliveredPortions = deliveredStops.reduce((s, x) => s + x.totalPortions, 0)

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
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
              {isToday ? 'Сегодня' : formatDateShort(targetDate)}
            </p>
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

        {!isToday && (
          <button
            type="button"
            onClick={jumpToToday}
            className="text-xs text-fg-muted hover:text-fg underline"
          >
            Вернуться на сегодня
          </button>
        )}
      </div>

      {stops.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border p-4 flex items-center justify-between gap-3" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div>
            <p className="text-xs text-fg-muted">Прогресс</p>
            <p className="text-2xl font-bold tabular-nums">
              {deliveredStops.length} <span className="text-fg-muted text-base font-medium">из {stops.length}</span>
            </p>
            <p className="text-xs text-fg-subtle mt-0.5">
              {deliveredPortions} / {totalPortions} порций доставлено
            </p>
          </div>
          <div className="w-16 h-16 relative">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" stroke="var(--color-border)" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="15" fill="none"
                stroke="var(--color-success)" strokeWidth="3"
                strokeDasharray={`${(deliveredStops.length / stops.length) * 94.2} 94.2`}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
              {Math.round((deliveredStops.length / stops.length) * 100)}%
            </div>
          </div>
        </div>
      )}

      {stops.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <MapPin className="w-10 h-10 mx-auto text-fg-subtle mb-3" />
          <p className="font-medium text-fg mb-1">На эту дату нет доставок</p>
          <p className="text-sm">Заказы либо отсутствуют, либо все отменены.</p>
        </div>
      ) : activeStops.length === 0 ? (
        <div className="rounded-2xl bg-success-bg/40 border border-success/20 p-8 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-success-bg flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-success-fg" strokeWidth={2.5} />
          </div>
          <p className="font-semibold text-success-fg mb-1">Все доставки выполнены!</p>
          <p className="text-sm text-success-fg/80">{stops.length} точек, {totalPortions} порций.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {activeStops.map((stop) => (
            <DeliveryCard
              key={`${stop.clientId}-${stop.locationId}`}
              stop={stop}
              userRole={userRole}
              onChanged={() => router.refresh()}
            />
          ))}
        </div>
      )}

      {deliveredStops.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
          <button
            type="button"
            onClick={() => setShowDelivered((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-bg/30 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm">
              <Check className="w-4 h-4 text-success-fg" />
              <span className="font-medium">Доставлено: {deliveredStops.length}</span>
            </div>
            {showDelivered ? <ChevronUp className="w-4 h-4 text-fg-muted" /> : <ChevronDown className="w-4 h-4 text-fg-muted" />}
          </button>

          {showDelivered && (
            <div className="border-t border-border divide-y divide-border">
              {deliveredStops.map((stop) => (
                <DeliveredRow
                  key={`${stop.clientId}-${stop.locationId}`}
                  stop={stop}
                  canUndo={userRole === 'ADMIN' || userRole === 'MANAGER'}
                  onChanged={() => router.refresh()}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DeliveryCard({
  stop,
  userRole,
  onChanged,
}: {
  stop: DeliveryStop
  userRole: UserRole
  onChanged: () => void
}) {
  const [isPending, startTransition] = useTransition()

  function handleDelivered() {
    startTransition(async () => {
      const result = await markStopDelivered({ orderIds: stop.orderIds })
      if (result.ok) {
        toast.success(`✓ ${stop.clientName} — доставлено`)
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(stop.locationAddress)}`

  return (
    <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-base truncate">{stop.clientName}</h3>
          <p className="text-sm text-fg-muted truncate">{stop.locationName}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold tabular-nums">{stop.totalPortions}</div>
          <div className="text-xs text-fg-muted">порций</div>
        </div>
      </div>

      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-2 text-sm text-info-fg hover:underline"
      >
        <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
        <span className="flex-1">{stop.locationAddress}</span>
      </a>

      <div className="flex flex-wrap gap-2 text-xs">
        {(stop.deliveryWindowFrom || stop.deliveryWindowTo) && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg text-fg-muted">
            <Clock className="w-3 h-3" />
            {formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)}
          </span>
        )}
        {stop.clientContactPhone && (
          <a
            href={`tel:${stop.clientContactPhone.replace(/\D/g, '')}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg text-info-fg hover:bg-border"
          >
            <Phone className="w-3 h-3" />
            {stop.clientContactPhone}
          </a>
        )}
      </div>

      <div className="rounded-xl bg-bg/40 px-3 py-2 space-y-1">
        {stop.items.map((item) => (
          <div key={item.orderId} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5 text-fg-muted shrink-0" />
              {MEAL_TYPE_LABELS[item.mealType]}
              <span className="text-xs text-fg-muted">
                · {PACKAGING_LABELS[item.packaging]}
              </span>
            </span>
            <span className="font-semibold tabular-nums shrink-0">{item.portions}</span>
          </div>
        ))}
      </div>

      {stop.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {stop.tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-warning-bg text-warning-fg text-xs font-medium">
              <Tag className="w-3 h-3" />
              {tag}
            </span>
          ))}
        </div>
      )}

      {stop.notes && (
        <div className="rounded-xl bg-warning-bg/30 border border-warning/20 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning-fg shrink-0 mt-0.5" />
          <p className="text-xs text-warning-fg whitespace-pre-line flex-1">{stop.notes}</p>
        </div>
      )}

      {userRole === 'COURIER' && (
        <button
          type="button"
          onClick={handleDelivered}
          disabled={isPending}
          className="w-full px-5 py-4 rounded-pill bg-success text-accent-fg font-semibold text-base hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 active:scale-[0.98]"
        >
          <Check className="w-5 h-5" strokeWidth={2.5} />
          {isPending ? 'Отмечаем…' : 'Доставлено'}
        </button>
      )}

      {userRole !== 'COURIER' && (
        <div className="text-xs text-fg-subtle text-center">
          {stop.hasOutForDelivery ? '🚚 В доставке' : 'Готовится / в обработке'}
        </div>
      )}
    </div>
  )
}

function DeliveredRow({
  stop,
  canUndo,
  onChanged,
}: {
  stop: DeliveryStop
  canUndo: boolean
  onChanged: () => void
}) {
  const [isPending, startTransition] = useTransition()

  function handleUndo() {
    if (!confirm(`Откатить доставку «${stop.clientName} — ${stop.locationName}»?`)) return
    startTransition(async () => {
      const result = await undoStopDelivered(stop.orderIds)
      if (result.ok) {
        toast.success('Доставка откачена')
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="px-4 py-3 flex items-center gap-3 opacity-70">
      <Check className="w-4 h-4 text-success-fg shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{stop.clientName}</p>
        <p className="text-xs text-fg-muted truncate">
          {stop.locationName} · {stop.totalPortions} порций
        </p>
      </div>
      {canUndo && (
        <button
          type="button"
          onClick={handleUndo}
          disabled={isPending}
          aria-label="Откатить доставку"
          title="Откатить отметку «доставлено»"
          className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
        >
          <Undo2 className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
