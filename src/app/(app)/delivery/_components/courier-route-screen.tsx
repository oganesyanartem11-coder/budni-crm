'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import {
  Check,
  ChevronRight,
  Clock3,
  MapPin,
  PackageCheck,
  Play,
  Route as RouteIcon,
  Sparkles,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { startOwnCourierRoute } from '../route-actions'
import { RouteRefreshControl } from './route-refresh-control'
import type {
  CourierRouteDayView,
  CourierRouteStopView,
} from '@/lib/delivery/courier-route-read-model'
import { formatDeliveryWindow, formatPortions } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props {
  route: CourierRouteDayView | null
}

function formatRouteDate(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Moscow',
  }).format(new Date(date))
}

function CourierStopLink({
  stop,
  next = false,
}: {
  stop: CourierRouteStopView
  next?: boolean
}) {
  const window = formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)
  const isLate = stop.state === 'LATE'
  const isNew = stop.state === 'NEW'

  return (
    <Link
      href={`/delivery/stops/${stop.id}`}
      className={cn(
        'group block cursor-pointer rounded-card border bg-surface p-4 shadow-[var(--shadow-card)]',
        'transition-colors hover:bg-surface-2 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
        '[touch-action:manipulation]',
        next ? 'border-data-orders/80' : 'border-border',
        isLate && 'border-danger/40',
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            'mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-2xl',
            next ? 'bg-data-orders-bg text-data-orders-ink' : 'bg-surface-2 text-fg-muted',
            isLate && 'bg-danger-bg text-danger-fg',
          )}
        >
          <MapPin className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold text-fg">{stop.locationName}</span>
            {isNew && (
              <span className="inline-flex items-center gap-1 rounded-pill bg-data-orders-bg px-2 py-1 text-xs font-semibold text-data-orders-ink">
                <Sparkles className="size-3" strokeWidth={1.75} aria-hidden="true" />
                Новая
              </span>
            )}
            {isLate && (
              <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2 py-1 text-xs font-semibold text-danger-fg">
                <Clock3 className="size-3" strokeWidth={1.75} aria-hidden="true" />
                Опоздание
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-sm font-medium text-fg-muted">{stop.clientName}</span>
          <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {window || 'Окно не указано'}
            </span>
            <span className="font-semibold tabular-nums text-fg">{formatPortions(stop.totalPortions)}</span>
          </span>
        </span>
        <ChevronRight className="mt-3 size-5 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
      </div>
    </Link>
  )
}

export function CourierRouteScreen({ route }: Props) {
  const router = useRouter()
  const [isStarting, startTransition] = useTransition()
  const [actionError, setActionError] = useState('')

  function startRoute() {
    setActionError('')
    startTransition(async () => {
      const result = await startOwnCourierRoute()
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      router.refresh()
    })
  }

  if (!route) {
    return (
      <section className="mx-auto max-w-2xl space-y-4" aria-labelledby="courier-route-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-data-orders-ink">Сегодня</p>
            <h1 id="courier-route-title" className="mt-1 text-2xl font-bold text-fg">Маршрут на сегодня</h1>
          </div>
          <RouteRefreshControl />
        </div>
        <div className="rounded-3xl border border-border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
          <RouteIcon className="mx-auto size-10 text-fg-subtle" strokeWidth={1.75} aria-hidden="true" />
          <h2 className="mt-4 text-lg font-bold text-fg">Маршрут ещё не сформирован</h2>
          <p className="mt-2 text-sm leading-6 text-fg-muted">Обновите экран чуть позже или свяжитесь с менеджером.</p>
        </div>
      </section>
    )
  }

  const progress = route.totalStops === 0
    ? 0
    : Math.round((route.deliveredStops / route.totalStops) * 100)
  const routeFinished = route.remainingStops === 0 && route.totalStops > 0

  return (
    <section className="mx-auto max-w-2xl space-y-5" aria-labelledby="courier-route-title">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold capitalize text-data-orders-ink">{formatRouteDate(route.deliveryDate)}</p>
          <h1 id="courier-route-title" className="mt-1 text-2xl font-bold text-fg">Маршрут на сегодня</h1>
          <p className="mt-1 text-sm text-fg-muted">{route.courierName}</p>
        </div>
        <RouteRefreshControl />
      </header>

      <div className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-fg-muted">Выполнено</p>
            <p className="mt-1 text-3xl font-extrabold tabular-nums text-fg" aria-label={`${route.deliveredStops} из ${route.totalStops}`}>
              {route.deliveredStops} <span className="text-base font-semibold text-fg-muted">из {route.totalStops}</span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold tabular-nums text-data-orders-ink">{progress}%</p>
            <p className="mt-1 text-xs font-medium text-fg-muted">Осталось {route.remainingStops}</p>
          </div>
        </div>
        <div
          className="mt-4 h-2.5 overflow-hidden rounded-pill bg-data-orders-bg"
          role="progressbar"
          aria-label="Прогресс маршрута"
          aria-valuemin={0}
          aria-valuemax={route.totalStops}
          aria-valuenow={route.deliveredStops}
        >
          <div
            className="h-full rounded-pill bg-data-orders transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          {route.deliveredPortions} из {route.totalPortions} порций доставлено
        </p>
      </div>

      {route.hasRouteChanges ? (
        <div className="rounded-card border border-data-orders/50 bg-data-orders-bg p-4 text-data-orders-ink">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <div>
              <h2 className="font-bold">Новые точки</h2>
              <ul className="mt-1 space-y-1 text-sm">
                {route.newStops.map((item) => (
                  <li key={item.id}>{item.locationName} · {item.clientName}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-11 items-center gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm font-medium text-fg-muted shadow-[var(--shadow-card)]">
          <Check className="size-4 text-data-orders-ink" strokeWidth={2} aria-hidden="true" />
          Маршрут без изменений
        </div>
      )}

      {route.state === 'NOT_STARTED' && route.totalStops > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={startRoute}
            disabled={isStarting}
            className="inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-6 py-4 text-base font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]"
          >
            <Play className="size-5" strokeWidth={1.75} aria-hidden="true" />
            {isStarting ? 'Начинаем…' : 'Начать маршрут'}
          </button>
          <p className="text-center text-xs leading-5 text-fg-muted">После старта новые назначения будут отмечены отдельно.</p>
        </div>
      )}

      <p className="sr-only" role="alert" aria-live="assertive">{actionError}</p>
      {actionError && (
        <div className="rounded-card border border-danger/30 bg-danger-bg p-4 text-sm text-danger-fg" role="alert">
          {actionError}
        </div>
      )}

      {routeFinished ? (
        <div className="rounded-3xl border border-success/25 bg-success-bg p-7 text-center">
          <PackageCheck className="mx-auto size-12 text-success-fg" strokeWidth={1.75} aria-hidden="true" />
          <h2 className="mt-3 text-xl font-bold text-success-fg">Все доставки выполнены</h2>
          <p className="mt-1 text-sm text-success-fg">Маршрут на сегодня завершён.</p>
        </div>
      ) : route.nextStop ? (
        <section className="space-y-3" aria-labelledby="next-stop-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="next-stop-title" className="text-lg font-bold text-fg">Следующая точка</h2>
            <span className="text-sm font-semibold text-data-orders-ink">{route.remainingStops} осталось</span>
          </div>
          <CourierStopLink stop={route.nextStop} next />
        </section>
      ) : null}

      {route.otherStops.length > 0 && (
        <section className="space-y-3" aria-labelledby="other-stops-title">
          <h2 id="other-stops-title" className="text-lg font-bold text-fg">Остальные</h2>
          <div className="space-y-3">
            {route.otherStops.map((item) => <CourierStopLink key={item.id} stop={item} />)}
          </div>
        </section>
      )}

      {route.completedStops.length > 0 && (
        <details className="rounded-card border border-border bg-surface shadow-[var(--shadow-card)]">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-bold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40">
            <Check className="size-4 text-success-fg" strokeWidth={2} aria-hidden="true" />
            Доставлено · {route.completedStops.length}
          </summary>
          <div className="space-y-2 border-t border-border p-3">
            {route.completedStops.map((item) => (
              <Link
                key={item.id}
                href={`/delivery/stops/${item.id}`}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-sm transition-colors hover:bg-surface-2 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Check className="size-4 shrink-0 text-success-fg" strokeWidth={2} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-fg">{item.locationName}</span>
                  <span className="block truncate text-xs text-fg-muted">{item.clientName} · {formatPortions(item.totalPortions)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-fg-subtle" strokeWidth={1.75} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
