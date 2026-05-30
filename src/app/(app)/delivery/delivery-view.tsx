'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Check, MapPin, Phone, Clock, AlertTriangle, Tag, Package, Undo2, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { markStopDelivered, undoStopDelivered } from './actions'
import { IssueDialog } from './_components/issue-dialog'
import { formatDateShort, formatDateNumeric, formatDeliveryWindow, formatLocations, formatPortions, formatTime, pluralize } from '@/lib/utils/format'
import { parseWindowToDate, getMskHoursMinutes } from '@/lib/utils/msk-window'
import { cn } from '@/lib/utils/cn'
import { PhoneLink } from '@/components/ui/phone-link'
import { MEAL_TYPE_LABELS, PACKAGING_LABELS } from '@/lib/constants/client'
import { DELIVERY_ISSUE_REASON_LABELS, type DeliveryIssueReason } from '@/lib/constants/delivery'
import { showActionError } from '@/lib/ui/optimistic-lock-toast'
import { EmptyState } from '@/components/ui/empty-state'
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
              {deliveredPortions} / {totalPortions} {pluralize(totalPortions, ['порция', 'порции', 'порций'])} доставлено
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
        <EmptyState
          icon={MapPin}
          title="На эту дату нет доставок"
          description="Заказы либо отсутствуют, либо все отменены."
        />
      ) : activeStops.length === 0 ? (
        <div className="rounded-2xl bg-success-bg/40 border border-success/20 p-8 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-success-bg flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-success-fg" strokeWidth={2.5} />
          </div>
          <p className="font-semibold text-success-fg mb-1">Все доставки выполнены!</p>
          <p className="text-sm text-success-fg/80">{formatLocations(stops.length)}, {formatPortions(totalPortions)}.</p>
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
                  targetDateIso={targetDateIso}
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
  const [isOptimistic, setIsOptimistic] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const hasIssue = !!stop.issueReportedAt

  function handleDelivered() {
    // Оптимистично прячем карточку: пользователь видит «исчезла», server-action
    // в фоне. router.refresh() в onChanged() реально переместит её в «доставлено».
    // На ошибке возвращаем карточку обратно с toast.
    setIsOptimistic(true)
    // 6.8b: optimistic lock — отдаём map orderId→updatedAt. Если менеджер
    // отменил/правил какой-то Order пока курьер ехал — markStopDelivered
    // откажет, не затирая чужие правки.
    const expectedUpdatedAts: Record<string, string> = {}
    for (const item of stop.items) {
      expectedUpdatedAts[item.orderId] = new Date(item.updatedAt).toISOString()
    }
    startTransition(async () => {
      const result = await markStopDelivered({ orderIds: stop.orderIds, expectedUpdatedAts })
      if (result.ok) {
        toast.success(`✓ ${stop.clientName} — доставлено`)
        onChanged()
      } else {
        setIsOptimistic(false)
        showActionError(result.error, onChanged)
      }
    })
  }

  // Rules of Hooks: useWindowState — кастомный хук (useState+useEffect внутри).
  // Должен вызываться ДО любого early return, иначе при переходе isOptimistic
  // false→true React поднимает "Rendered fewer hooks" → uncaught → error boundary.
  const windowState = useWindowState(stop.deliveryWindowFrom, stop.deliveryWindowTo)

  if (isOptimistic) return null

  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(stop.locationAddress)}`
  const isLateState = windowState === 'late'
  const hasWindow = !!(stop.deliveryWindowFrom || stop.deliveryWindowTo)

  return (
    <div
      className={cn(
        'rounded-2xl bg-surface border p-4 space-y-3',
        stop.hasLateAlert ? 'border-danger/40' : 'border-border'
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-base truncate">{stop.clientName}</h3>
          <p className="text-sm text-fg-muted truncate">{stop.locationName}</p>
          {hasWindow && (
            <p className={cn('text-sm mt-0.5 flex items-center gap-1.5', isLateState ? 'text-danger-fg font-medium' : 'text-fg-muted')}>
              <Clock className="w-3.5 h-3.5" />
              Окно: {formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)}
            </p>
          )}
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

      {stop.clientContactPhone && (
        <div className="flex flex-wrap gap-2 text-xs">
          <PhoneLink
            phone={stop.clientContactPhone}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-bg text-info-fg"
          >
            <Phone className="w-3 h-3" />
            {stop.clientContactPhone}
          </PhoneLink>
        </div>
      )}

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

      {hasIssue && (
        <button
          type="button"
          onClick={() => setIssueOpen(true)}
          className="w-full rounded-xl bg-danger-bg/40 border border-danger/30 px-3 py-2 flex items-start gap-2 text-left hover:bg-danger-bg/50 transition-colors"
        >
          <AlertTriangle className="w-4 h-4 text-danger-fg shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-danger-fg">
              Сообщено о проблеме: {stop.issueReason ? DELIVERY_ISSUE_REASON_LABELS[stop.issueReason as DeliveryIssueReason] : '—'}
            </p>
            {stop.issueComment && (
              <p className="text-xs text-danger-fg/80 mt-0.5 italic">«{stop.issueComment}»</p>
            )}
            <p className="text-[10px] text-danger-fg/60 mt-0.5">Нажмите чтобы изменить причину</p>
          </div>
        </button>
      )}

      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
        {!hasIssue && (
          <button
            type="button"
            onClick={() => setIssueOpen(true)}
            className="text-sm text-fg-muted hover:text-danger-fg transition-colors underline underline-offset-2 self-start lg:self-auto py-2"
          >
            Не смог доставить
          </button>
        )}
        <DeliveredButton
          stop={stop}
          userRole={userRole}
          windowState={windowState}
          isPending={isPending}
          onClick={handleDelivered}
        />
      </div>

      <IssueDialog
        open={issueOpen}
        orderIds={stop.orderIds}
        initialReason={stop.issueReason as DeliveryIssueReason | null}
        initialComment={stop.issueComment}
        onClose={() => setIssueOpen(false)}
        onReported={onChanged}
      />
    </div>
  )
}

/**
 * Состояния кнопки «Доставлено»:
 * - before-window: окно ещё не началось → disabled с подсказкой «Окно с HH:mm»
 * - in-window: активная, брендовый цвет
 * - late: прошло > 30 мин после конца окна → активная, красная (визуальный сигнал)
 * COURIER блокируется server-action'ом до начала окна. ADMIN/MANAGER может нажать всегда.
 */
function DeliveredButton({
  stop,
  userRole,
  windowState,
  isPending,
  onClick,
}: {
  stop: DeliveryStop
  userRole: UserRole
  windowState: WindowState
  isPending: boolean
  onClick: () => void
}) {
  const isBefore = windowState === 'before' && userRole === 'COURIER'
  const isLate = windowState === 'late'

  // Используем max-lg:* и lg:* как взаимоисключающие медиа-режимы, чтобы
  // не было гонки w-full vs lg:w-fit в одном правиле (предыдущие попытки
  // в 6.5-fix-4 не сработали — w-full побеждал на десктопе).
  // max-lg:w-full применяется только < 1024px, lg:w-fit — только >= 1024px.
  const sizeClasses =
    'max-lg:w-full max-lg:min-h-14 max-lg:px-5 max-lg:py-4 max-lg:text-base ' +
    'lg:w-fit lg:min-h-10 lg:py-2 lg:px-6 lg:text-sm'

  if (isBefore) {
    return (
      <div className="w-full lg:flex lg:justify-end">
        <button
          type="button"
          disabled
          className={cn(
            sizeClasses,
            'rounded-pill bg-bg border border-border text-fg-subtle font-semibold flex items-center justify-center gap-2 cursor-not-allowed'
          )}
        >
          <Clock className="w-5 h-5 lg:w-4 lg:h-4" />
          Окно с {stop.deliveryWindowFrom}
        </button>
      </div>
    )
  }

  return (
    <div className="w-full lg:flex lg:justify-end">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className={cn(
          sizeClasses,
          'rounded-pill font-semibold transition-opacity disabled:opacity-50 flex items-center justify-center gap-2 active:scale-[0.98]',
          isLate
            ? 'bg-danger text-accent-fg hover:opacity-90'
            : 'bg-success text-accent-fg hover:opacity-90'
        )}
      >
        <Check className="w-5 h-5 lg:w-4 lg:h-4" strokeWidth={2.5} />
        {isPending ? 'Отмечаем…' : isLate ? 'Доставлено (опоздание)' : 'Доставлено'}
      </button>
    </div>
  )
}

type WindowState = 'before' | 'in' | 'after' | 'late' | 'unknown'

function useWindowState(fromHHmm: string | null, toHHmm: string | null): WindowState {
  const [state, setState] = useState<WindowState>(() => computeWindowState(fromHHmm, toHHmm))
  useEffect(() => {
    setState(computeWindowState(fromHHmm, toHHmm))
    const id = setInterval(() => setState(computeWindowState(fromHHmm, toHHmm)), 60_000)
    return () => clearInterval(id)
  }, [fromHHmm, toHHmm])
  return state
}

function computeWindowState(fromHHmm: string | null, toHHmm: string | null): WindowState {
  if (!fromHHmm && !toHHmm) return 'unknown'
  // Окно задано в МСК. Браузер пользователя где угодно — пересчитываем в МСК через хелпер.
  const fromMins = fromHHmm ? hhmmToMinutes(fromHHmm) : null
  const toMins = toHHmm ? hhmmToMinutes(toHHmm) : null
  const { hours, minutes } = getMskHoursMinutes()
  const nowMins = hours * 60 + minutes
  if (fromMins !== null && nowMins < fromMins) return 'before'
  if (toMins !== null && nowMins > toMins + 30) return 'late'
  if (toMins !== null && nowMins > toMins) return 'after'
  return 'in'
}

function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2])
}

function DeliveredRow({
  stop,
  targetDateIso,
  canUndo,
  onChanged,
}: {
  stop: DeliveryStop
  targetDateIso: string
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

  const windowText = (stop.deliveryWindowFrom || stop.deliveryWindowTo)
    ? `Окно: ${formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)}`
    : null
  const deliveredAt = stop.deliveredAt ? new Date(stop.deliveredAt) : null
  const windowEnd = parseWindowToDate(stop.deliveryWindowTo, new Date(targetDateIso))
  const lateMinutes = deliveredAt && windowEnd
    ? Math.round((deliveredAt.getTime() - windowEnd.getTime()) / 60_000)
    : 0
  const isLate = lateMinutes >= 1
  const deliveredText = deliveredAt ? `Доставлено в ${formatTime(deliveredAt)}` : null

  return (
    <div className="px-4 py-3 flex items-center gap-3 opacity-70">
      <Check className="w-4 h-4 text-success-fg shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{stop.clientName}</p>
        <p className="text-xs text-fg-muted truncate">
          {stop.locationName} · {formatPortions(stop.totalPortions)}
        </p>
        {(windowText || deliveredText) && (
          <p className="text-xs text-fg-subtle truncate mt-0.5">
            {windowText && <span>{windowText}</span>}
            {windowText && deliveredText && <span> · </span>}
            {deliveredText && (
              isLate ? (
                <span className="text-danger-fg font-medium">
                  {deliveredText} (опоздание {lateMinutes} мин)
                </span>
              ) : (
                <span>{deliveredText}</span>
              )
            )}
          </p>
        )}
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
