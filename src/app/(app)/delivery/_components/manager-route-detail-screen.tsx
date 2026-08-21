import Link from 'next/link'
import {
  ArrowLeft,
  Clock3,
  History,
  MapPin,
  Navigation,
  Package,
  Phone,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ManagerStopActions } from './manager-stop-actions'
import { RouteRefreshControl } from './route-refresh-control'
import type {
  ManagerCourierRouteDetailView,
  ManagerStopSummaryView,
} from '@/lib/delivery/manager-control-read-model'
import { getDeliveryGeoResultLabel } from '@/lib/delivery/delivery-geo-labels'
import { MEAL_TYPE_LABELS, PACKAGING_LABELS } from '@/lib/constants/client'
import {
  formatDeliveryWindow,
  formatMskTime,
  formatPhoneLink,
  formatPortions,
} from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props {
  data: ManagerCourierRouteDetailView
}

const STOP_STATE_LABEL = {
  NEW: 'Новая',
  PLANNED: 'По плану',
  LATE: 'Опоздание',
  DELIVERED: 'Доставлено',
  CANCELLED: 'Отменено',
} as const

const OVERRIDE_STATUS_LABEL = {
  PENDING: 'Ждёт решения',
  APPROVED: 'Подтверждён',
  REJECTED: 'Отклонён',
  EXPIRED: 'Истёк',
} as const

function StopStateBadge({ stop }: { stop: ManagerStopSummaryView }) {
  return (
    <span className={cn(
      'rounded-pill px-2.5 py-1 text-xs font-bold',
      stop.state === 'DELIVERED' && 'bg-success-bg text-success-fg',
      stop.state === 'LATE' && 'bg-danger-bg text-danger-fg',
      stop.state === 'NEW' && 'bg-data-orders-bg text-data-orders-ink',
      stop.state === 'PLANNED' && 'bg-surface-2 text-fg-muted',
      stop.state === 'CANCELLED' && 'bg-surface-2 text-fg-muted',
    )}>
      {STOP_STATE_LABEL[stop.state]}
    </span>
  )
}

function StopSelector({
  stop,
  routeDayId,
  selected,
}: {
  stop: ManagerStopSummaryView
  routeDayId: string
  selected: boolean
}) {
  return (
    <li>
      <Link
        href={`/delivery/control/${routeDayId}?stop=${encodeURIComponent(stop.id)}`}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'block min-h-11 rounded-card border p-4 transition-colors motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
          selected
            ? 'border-primary bg-surface shadow-[var(--shadow-card)]'
            : 'border-border bg-surface hover:bg-surface-2',
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block font-bold text-fg">{stop.locationName}</span>
            <span className="mt-0.5 block text-sm text-fg-muted">{stop.clientName}</span>
          </span>
          <span className="flex flex-wrap justify-end gap-1.5">
            <StopStateBadge stop={stop} />
            {stop.pendingOverride && (
              <span className="rounded-pill bg-warning-bg px-2.5 py-1 text-xs font-bold text-warning-fg">Ждёт решения</span>
            )}
          </span>
        </span>
        <span className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm text-fg-muted">
          <span>{formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)}</span>
          <span className="font-semibold text-fg">{formatPortions(stop.totalPortions)}</span>
        </span>
      </Link>
    </li>
  )
}

function progressPercent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100)
}

export function ManagerRouteDetailScreen({ data }: Props) {
  const route = data.route
  const stop = data.selectedStop
  const progress = progressPercent(route.deliveredStops, route.totalStops)
  const phoneLink = formatPhoneLink(stop?.contactPhone)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Маршрут курьера"
        subtitle={`${route.courierName} · ${route.deliveredStops} из ${route.totalStops} точек выполнено`}
        className="mb-0"
        actions={(
          <>
            <Link href="/delivery/control" className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
              <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              К контролю
            </Link>
            <RouteRefreshControl label="Обновить маршрут курьера" announcement="Маршрут курьера обновлён" />
          </>
        )}
      />

      <section className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="route-progress-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-data-orders-bg text-sm font-extrabold text-data-orders-ink">
              {route.initials}
            </span>
            <div>
              <h2 id="route-progress-title" className="font-bold text-fg">{route.courierName}</h2>
              <p className="text-sm text-fg-muted">Осталось {route.remainingStops} · опаздывают {route.activeLateStops}</p>
            </div>
          </div>
          <p className="text-sm font-bold tabular-nums text-data-orders-ink">{progress}%</p>
        </div>
        <div className="mt-4 h-2.5 overflow-hidden rounded-pill bg-data-orders-bg" role="progressbar" aria-label="Прогресс маршрута" aria-valuemin={0} aria-valuemax={route.totalStops} aria-valuenow={route.deliveredStops}>
          <div className="h-full rounded-pill bg-data-orders" style={{ width: `${progress}%` }} />
        </div>
        {stop?.pendingOverride && (
          <a href="#manager-stop-actions" className="mt-4 inline-flex min-h-11 items-center rounded-pill bg-warning-bg px-4 py-2 text-sm font-bold text-warning-fg transition-colors hover:bg-brand-yellow-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:ring-offset-2">
            Override ждёт решения · перейти к действиям
          </a>
        )}
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
        {stop && (
          <div className="order-1 min-w-0 space-y-4">
            <section className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="selected-stop-title">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-data-orders-ink">{stop.clientName}</p>
                  <h2 id="selected-stop-title" className="mt-1 text-2xl font-bold text-fg">{stop.locationName}</h2>
                  <p className="mt-1 break-words text-sm leading-6 text-fg-muted">{stop.locationAddress}</p>
                </div>
                <StopStateBadge stop={stop} />
              </div>

              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-card bg-surface-2 p-3">
                  <dt className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-fg-muted"><Clock3 className="size-4" strokeWidth={1.75} aria-hidden="true" /> Окно</dt>
                  <dd className="mt-1 font-semibold text-fg">{formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)}</dd>
                </div>
                <div className="rounded-card bg-surface-2 p-3">
                  <dt className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-fg-muted"><UserRound className="size-4" strokeWidth={1.75} aria-hidden="true" /> Контакт</dt>
                  <dd className="mt-1 font-semibold text-fg">{stop.contactName || 'Не указан'}</dd>
                  {stop.contactPhone && phoneLink && (
                    <dd className="mt-1"><a href={`tel:${phoneLink}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-data-revenue-ink underline decoration-transparent underline-offset-4 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><Phone className="size-4" strokeWidth={1.75} aria-hidden="true" />{stop.contactPhone}</a></dd>
                  )}
                </div>
              </dl>

              {(stop.deliveryInstructions || stop.contactNotes) && (
                <div className="mt-4 rounded-card border border-border bg-surface-2 p-4">
                  <h3 className="font-bold text-fg">Инструкции</h3>
                  {stop.deliveryInstructions && <p className="mt-2 text-sm leading-6 text-fg">{stop.deliveryInstructions}</p>}
                  {stop.contactNotes && <p className="mt-1 text-sm leading-6 text-fg-muted">{stop.contactNotes}</p>}
                </div>
              )}

              <div className="mt-5">
                <h3 className="flex items-center gap-2 font-bold text-fg"><Package className="size-4" strokeWidth={1.75} aria-hidden="true" /> Состав доставки</h3>
                <ul className="mt-3 divide-y divide-border rounded-card border border-border px-4">
                  {stop.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                      <div>
                        <p className="font-semibold text-fg">{MEAL_TYPE_LABELS[item.mealType]}</p>
                        <p className="text-sm text-fg-muted">{PACKAGING_LABELS[item.packaging]}{item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}</p>
                        {item.notes && <p className="mt-1 text-sm text-fg-muted">{item.notes}</p>}
                      </div>
                      <span className="font-bold tabular-nums text-fg">{formatPortions(item.portions)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="gps-title">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-2xl bg-info-bg text-info-fg"><Navigation className="size-5" strokeWidth={1.75} aria-hidden="true" /></span>
                <div>
                  <h2 id="gps-title" className="font-bold text-fg">GPS-проверка</h2>
                  <p className="text-sm text-fg-muted">Радиус геозоны: {stop.geofenceEnabled ? `${stop.geofenceRadiusM} м` : 'отключён'}</p>
                </div>
              </div>
              {stop.latestGeoAttempt ? (
                <dl className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div><dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Результат</dt><dd className="mt-1 break-words font-semibold text-fg">{getDeliveryGeoResultLabel(stop.latestGeoAttempt.result)}</dd></div>
                  <div><dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Расстояние</dt><dd className="mt-1 font-semibold text-fg">{stop.latestGeoAttempt.distanceM === null ? '—' : `${Math.round(stop.latestGeoAttempt.distanceM)} м`}</dd></div>
                  <div><dt className="text-xs font-bold uppercase tracking-wide text-fg-muted">Получено</dt><dd className="mt-1 font-semibold text-fg">{formatMskTime(stop.latestGeoAttempt.receivedAt)}</dd></div>
                </dl>
              ) : <p className="mt-4 text-sm text-fg-muted">Курьер ещё не запускал GPS-проверку.</p>}
            </section>

            {stop.override && (
              <section className="rounded-3xl border border-warning/35 bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="override-title">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="override-title" className="flex items-center gap-2 font-bold text-fg"><ShieldCheck className="size-5 text-warning-fg" strokeWidth={1.75} aria-hidden="true" /> Override</h2>
                  <span className={cn(
                    'rounded-pill px-2.5 py-1 text-xs font-bold',
                    stop.override.status === 'PENDING' ? 'bg-warning-bg text-warning-fg' : 'bg-surface-2 text-fg',
                  )}>{OVERRIDE_STATUS_LABEL[stop.override.status]}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-fg">{stop.override.comment}</p>
                {stop.override.resolvedByName && <p className="mt-2 text-sm text-fg-muted">Решил: {stop.override.resolvedByName}</p>}
                {stop.override.resolutionComment && <p className="mt-1 text-sm text-fg-muted">Комментарий: {stop.override.resolutionComment}</p>}
              </section>
            )}

            <section id="manager-stop-actions" className="scroll-mt-4 rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="actions-title">
              <h2 id="actions-title" className="sr-only">Действия менеджера</h2>
              <ManagerStopActions
                key={`${stop.id}:${stop.version}:${stop.override?.id ?? 'none'}:${stop.override?.status ?? 'none'}`}
                stop={stop}
                couriers={data.couriers}
                currentCourierId={route.courierId}
              />
            </section>

            <section className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="timeline-title">
              <h2 id="timeline-title" className="flex items-center gap-2 text-lg font-bold text-fg"><History className="size-5" strokeWidth={1.75} aria-hidden="true" /> Хронология</h2>
              {stop.timeline.length > 0 ? (
                <ol className="mt-4 space-y-4 border-l border-border pl-5">
                  {stop.timeline.map((event) => (
                    <li key={event.id} className="relative">
                      <span className="absolute -left-[1.56rem] top-1.5 size-2.5 rounded-full border-2 border-surface bg-data-orders" aria-hidden="true" />
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="font-semibold text-fg">{event.title}</h3>
                        <time className="text-xs font-semibold tabular-nums text-fg-muted">{formatMskTime(event.at)}</time>
                      </div>
                      {event.detail && <p className="mt-1 break-words text-sm leading-6 text-fg-muted">{event.detail}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-3 text-sm text-fg-muted">Событий пока нет.</p>
              )}
            </section>
          </div>
        )}

        <section className="order-2 min-w-0" aria-labelledby="route-stops-title">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="route-stops-title" className="text-xl font-bold text-fg">Точки маршрута</h2>
            <span className="text-sm font-semibold text-fg-muted">{data.stops.length}</span>
          </div>
          {data.stops.length > 0 ? (
            <ol className="space-y-3">
              {data.stops.map((routeStop) => (
                <StopSelector
                  key={routeStop.id}
                  stop={routeStop}
                  routeDayId={route.routeDayId}
                  selected={routeStop.id === stop?.id}
                />
              ))}
            </ol>
          ) : (
            <div className="rounded-3xl border border-border bg-surface p-7 text-center shadow-[var(--shadow-card)]">
              <MapPin className="mx-auto size-10 text-fg-muted" strokeWidth={1.75} aria-hidden="true" />
              <h2 className="mt-3 font-bold text-fg">В маршруте нет точек</h2>
              <p className="mt-1 text-sm text-fg-muted">Вернитесь в контроль и назначьте доставку.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
