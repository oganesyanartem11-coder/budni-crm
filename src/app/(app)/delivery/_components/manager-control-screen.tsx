import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Route as RouteIcon,
  ShieldAlert,
  Truck,
  UserRoundCheck,
  UserRoundX,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { CourierListJump } from './courier-list-jump'
import { RouteRefreshControl } from './route-refresh-control'
import type {
  ManagerCourierCardView,
  ManagerDeliveryControlView,
  ManagerLastActionKind,
  ManagerStopSummaryView,
} from '@/lib/delivery/manager-control-read-model'
import { formatDeliveryWindow, formatPortions } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props {
  data: ManagerDeliveryControlView
}

function formatControlDate(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Moscow',
  }).format(date)
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(date)
}

const LAST_ACTION_LABEL: Record<ManagerLastActionKind, string> = {
  ROUTE_STARTED: 'Начал маршрут',
  STOP_DELIVERED: 'Подтвердил доставку',
  GPS_CHECK: 'Проверил GPS',
  OVERRIDE_REQUESTED: 'Запросил подтверждение',
}

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string
  value: number
  icon: LucideIcon
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'info'
}) {
  return (
    <div className={cn(
      'rounded-card border bg-surface p-4 shadow-[var(--shadow-card)]',
      tone === 'danger' && value > 0 && 'border-danger/35',
      tone === 'warning' && value > 0 && 'border-warning/40',
      tone === 'info' && value > 0 && 'border-info/30',
      tone === 'success' && 'border-success/25',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-fg-muted">{label}</p>
          <p className="mt-2 text-3xl font-extrabold tabular-nums text-fg">{value}</p>
        </div>
        <span className={cn(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-fg-muted',
          tone === 'danger' && value > 0 && 'bg-danger-bg text-danger-fg',
          tone === 'warning' && value > 0 && 'bg-warning-bg text-warning-fg',
          tone === 'info' && value > 0 && 'bg-info-bg text-info-fg',
          tone === 'success' && 'bg-success-bg text-success-fg',
        )}>
          <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}

function StopLine({ stop }: { stop: ManagerStopSummaryView }) {
  const window = formatDeliveryWindow(stop.deliveryWindowFrom, stop.deliveryWindowTo)
  return (
    <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-semibold text-fg">{stop.locationName}</p>
        <p className="mt-0.5 text-sm text-fg-muted">{stop.clientName}</p>
        <p className="mt-1 text-xs font-medium text-fg-muted">{window || 'Окно не указано'}</p>
      </div>
      <span className="shrink-0 text-sm font-bold tabular-nums text-fg">{formatPortions(stop.totalPortions)}</span>
    </li>
  )
}

function CourierCard({ courier }: { courier: ManagerCourierCardView }) {
  const progress = courier.totalStops === 0
    ? 0
    : Math.round((courier.deliveredStops / courier.totalStops) * 100)
  return (
    <Link
      href={`/delivery/control/${courier.routeDayId}`}
      className={cn(
        'group block min-h-11 rounded-3xl border bg-surface p-4 sm:p-5 shadow-[var(--shadow-card)]',
        'transition-colors hover:bg-surface-2 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
        courier.activeLateStops > 0 ? 'border-danger/40' : 'border-border',
      )}
      aria-label={`${courier.courierName}: выполнено ${courier.deliveredStops} из ${courier.totalStops}; опаздывают ${courier.activeLateStops}; ждут решения ${courier.pendingOverrides}; открыть маршрут`}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-data-orders-bg text-sm font-extrabold text-data-orders-ink">
          {courier.initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-fg">{courier.courierName}</h2>
              <p className="mt-0.5 text-sm text-fg-muted">
                {courier.deliveredStops} из {courier.totalStops} · осталось {courier.remainingStops}
              </p>
            </div>
            <ArrowRight className="mt-1 size-5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-pill bg-data-orders-bg" role="progressbar" aria-label={`Прогресс ${courier.courierName}`} aria-valuemin={0} aria-valuemax={courier.totalStops} aria-valuenow={courier.deliveredStops}>
            <div className="h-full rounded-pill bg-data-orders" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {courier.activeLateStops > 0 && (
              <span className="rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger-fg">Опаздывают · {courier.activeLateStops}</span>
            )}
            {courier.newStops > 0 && (
              <span className="rounded-pill bg-data-orders-bg px-2.5 py-1 text-xs font-bold text-data-orders-ink">Новые · {courier.newStops}</span>
            )}
            {courier.pendingOverrides > 0 && (
              <span className="rounded-pill bg-warning-bg px-2.5 py-1 text-xs font-bold text-warning-fg">Ждут решения · {courier.pendingOverrides}</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4">
        <div className="min-w-0 rounded-card bg-surface-2 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-fg-muted">Следующая точка</p>
          {courier.nextStop ? (
            <>
              <p className="mt-1 break-words text-sm font-semibold text-fg">{courier.nextStop.locationName}</p>
              <p className="mt-0.5 break-words text-xs text-fg-muted">{courier.nextStop.clientName}</p>
            </>
          ) : (
            <p className="mt-1 text-sm font-semibold text-fg-muted">
              {courier.remainingStops === 0 ? 'Маршрут завершён' : 'Нет открытых точек'}
            </p>
          )}
        </div>
        <div className="min-w-0 rounded-card border border-border p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-fg-muted">Последнее действие</p>
          {courier.lastAction ? (
            <>
              <p className="mt-1 text-sm font-semibold text-fg">{LAST_ACTION_LABEL[courier.lastAction.kind]}</p>
              {courier.lastAction.locationName && (
                <p className="mt-0.5 break-words text-xs text-fg-muted">{courier.lastAction.locationName}</p>
              )}
              <p className="mt-1 text-xs font-medium tabular-nums text-fg-muted">{formatTime(courier.lastAction.at)}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-fg-muted">Действий пока нет</p>
          )}
        </div>
      </div>
    </Link>
  )
}

export function ManagerControlScreen({ data }: Props) {
  const summary = data.summary
  const hasAttention = summary.activeLateStops > 0
    || summary.unassignedStops > 0
    || summary.pendingOverrides > 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Контроль доставки"
        subtitle={`${formatControlDate(data.deliveryDate)} · обновление каждые 30 секунд, пока вкладка открыта`}
        className="mb-0"
        actions={(
          <>
            <CourierListJump count={data.couriers.length} />
            <Link href="/delivery/control/analytics" className="inline-flex min-h-11 items-center rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              Аналитика
            </Link>
            <Link href="/delivery" className="inline-flex min-h-11 items-center rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
              Сводка
            </Link>
            <RouteRefreshControl label="Обновить данные" announcement="Контроль доставки обновлён" />
          </>
        )}
      />

      <section aria-labelledby="today-metrics-title">
        <h2 id="today-metrics-title" className="sr-only">Показатели на сегодня</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
          <MetricCard label="Курьеры на маршруте" value={summary.workingCouriers} icon={UserRoundCheck} />
          <MetricCard label="Всего точек" value={summary.totalStops} icon={RouteIcon} />
          <MetricCard label="Доставлено" value={summary.deliveredStops} icon={CheckCircle2} tone="success" />
          <MetricCard label="Опаздывают" value={summary.activeLateStops} icon={AlertTriangle} tone="danger" />
          <MetricCard label="InDrive" value={summary.externalStops} icon={Truck} tone="info" />
          <MetricCard label="Не назначено" value={summary.unassignedStops} icon={UserRoundX} tone="warning" />
          <MetricCard label="Ждут решения" value={summary.pendingOverrides} icon={ShieldAlert} tone="warning" />
        </div>
      </section>

      {hasAttention && (
        <section className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="attention-title">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-2xl bg-warning-bg text-warning-fg">
              <Clock3 className="size-5" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <div>
              <h2 id="attention-title" className="text-lg font-bold text-fg">Требует внимания</h2>
              <p className="text-sm text-fg-muted">Сначала разберите опоздания, override и неназначенные точки.</p>
            </div>
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-3">
            <li className="rounded-card bg-danger-bg px-4 py-3 text-sm font-semibold text-danger-fg">Опаздывают: {summary.activeLateStops}</li>
            <li className="rounded-card bg-warning-bg px-4 py-3 text-sm font-semibold text-warning-fg">Ждут решения: {summary.pendingOverrides}</li>
            <li className="rounded-card bg-warning-bg px-4 py-3 text-sm font-semibold text-warning-fg">Не назначено: {summary.unassignedStops}</li>
          </ul>
        </section>
      )}

      <section
        id="courier-routes"
        className="scroll-mt-4 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-4"
        aria-labelledby="couriers-title"
        tabIndex={-1}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="couriers-title" className="text-xl font-bold text-fg">Курьеры на маршруте</h2>
            <p className="mt-1 text-sm text-fg-muted">Сначала показаны маршруты, где нужна реакция.</p>
          </div>
          <span className="text-sm font-semibold text-fg-muted">{data.couriers.length}</span>
        </div>
        {data.couriers.length > 0 ? (
          <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {data.couriers.map((courier) => <CourierCard key={courier.routeDayId} courier={courier} />)}
          </div>
        ) : (
          <div className="rounded-3xl border border-border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
            <UserRoundX className="mx-auto size-10 text-fg-muted" strokeWidth={1.75} aria-hidden="true" />
            <h2 className="mt-3 text-lg font-bold text-fg">Маршрутов курьеров пока нет</h2>
            <p className="mt-1 text-sm text-fg-muted">После назначения точки появятся здесь автоматически.</p>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-info/25 bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="external-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="external-title" className="text-lg font-bold text-fg">InDrive</h2>
            <span className="rounded-pill bg-info-bg px-2.5 py-1 text-xs font-bold text-info-fg">{data.externalStops.length}</span>
          </div>
          {data.externalStops.length > 0 ? (
            <ul className="mt-4 divide-y divide-border">{data.externalStops.map((stop) => <StopLine key={stop.id} stop={stop} />)}</ul>
          ) : <p className="mt-4 text-sm text-fg-muted">Внешних доставок нет.</p>}
        </section>

        <section className="rounded-3xl border border-warning/30 bg-surface p-5 shadow-[var(--shadow-card)]" aria-labelledby="unassigned-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="unassigned-title" className="text-lg font-bold text-fg">Не назначено</h2>
            <span className="rounded-pill bg-warning-bg px-2.5 py-1 text-xs font-bold text-warning-fg">{data.unassignedStops.length}</span>
          </div>
          {data.unassignedStops.length > 0 ? (
            <ul className="mt-4 divide-y divide-border">{data.unassignedStops.map((stop) => <StopLine key={stop.id} stop={stop} />)}</ul>
          ) : <p className="mt-4 text-sm text-fg-muted">Все точки распределены.</p>}
        </section>
      </div>
    </div>
  )
}
