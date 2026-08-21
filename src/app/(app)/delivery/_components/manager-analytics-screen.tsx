import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  AlarmClock,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Gauge,
  PackageCheck,
  ShieldCheck,
  Timer,
  UsersRound,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { RouteRefreshControl } from './route-refresh-control'
import type {
  DeliveryAnalyticsMetrics,
  DeliveryAnalyticsPeriod,
  DeliveryAnalyticsPeriodKind,
  DeliveryAnalyticsSummary,
} from '@/lib/delivery/delivery-analytics'
import { cn } from '@/lib/utils/cn'

interface Props {
  analytics: DeliveryAnalyticsSummary
  period: DeliveryAnalyticsPeriod
}

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatPeriodLabel(period: DeliveryAnalyticsPeriod): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: period.from.getUTCFullYear() === period.to.getUTCFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  })
  if (period.from.getTime() === period.to.getTime()) return formatter.format(period.from)
  return `${formatter.format(period.from)} — ${formatter.format(period.to)}`
}

function numberValue(value: number | null, suffix = ''): string {
  if (value === null) return '—'
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}${suffix}`
}

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  icon: LucideIcon
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'info'
}) {
  return (
    <div className={cn(
      'rounded-card border border-border bg-surface p-4 shadow-[var(--shadow-card)]',
      tone === 'success' && 'border-success/25',
      tone === 'danger' && 'border-danger/30',
      tone === 'warning' && 'border-warning/35',
      tone === 'info' && 'border-info/30',
    )}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-fg-muted">{label}</p>
          <p className="mt-2 text-3xl font-extrabold tabular-nums text-fg">{value}</p>
        </div>
        <span className={cn(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-fg-muted',
          tone === 'success' && 'bg-success-bg text-success-fg',
          tone === 'danger' && 'bg-danger-bg text-danger-fg',
          tone === 'warning' && 'bg-warning-bg text-warning-fg',
          tone === 'info' && 'bg-info-bg text-info-fg',
        )}>
          <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}

const RANGE_LINKS: Array<{
  kind: Exclude<DeliveryAnalyticsPeriodKind, 'period'>
  label: string
  href: string
}> = [
  { kind: 'today', label: 'Сегодня', href: '/delivery/control/analytics' },
  { kind: '7d', label: '7 дней', href: '/delivery/control/analytics?range=7d' },
  { kind: '30d', label: '30 дней', href: '/delivery/control/analytics?range=30d' },
]

function CourierMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="mt-1 font-bold tabular-nums text-fg">{value}</dd>
    </div>
  )
}

function CourierAnalyticsCard({
  courier,
}: {
  courier: DeliveryAnalyticsSummary['couriers'][number]
}) {
  return (
    <article className="rounded-3xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-2xl bg-data-orders-bg text-data-orders-ink">
          <UsersRound className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-bold text-fg">{courier.courierName}</h3>
          <p className="text-sm text-fg-muted">{courier.physicalDeliveries} физических доставок</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CourierMetric label="Вовремя" value={courier.onTime} />
        <CourierMetric label="Опоздали" value={courier.late} />
        <CourierMetric label="Вовремя, %" value={numberValue(courier.onTimePercent, '%')} />
        <CourierMetric label="Overrides" value={courier.overrides} />
        <CourierMetric label="Средняя задержка" value={numberValue(courier.averageDelayMinutes, ' мин')} />
        <CourierMetric label="Максимальная задержка" value={numberValue(courier.maxDelayMinutes, ' мин')} />
        <CourierMetric label="С окном" value={courier.punctualityEligible} />
        <CourierMetric label="Всего" value={courier.physicalDeliveries} />
      </dl>
    </article>
  )
}

export function ManagerAnalyticsScreen({ analytics, period }: Props) {
  const metrics: DeliveryAnalyticsMetrics = analytics.overall
  return (
    <div className="space-y-6">
      <PageHeader
        title="Аналитика доставки"
        subtitle={`${formatPeriodLabel(period)} · по физическим точкам, не по заказам`}
        className="mb-0"
        actions={(
          <>
            <Link href="/delivery/control" className="inline-flex min-h-11 items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
              <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              К контролю
            </Link>
            <RouteRefreshControl label="Обновить аналитику" announcement="Аналитика доставки обновлена" />
          </>
        )}
      />

      <section className="rounded-3xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]" aria-labelledby="period-title">
        <h2 id="period-title" className="sr-only">Период аналитики</h2>
        <div className="flex flex-wrap gap-2">
          {RANGE_LINKS.map((range) => (
            <Link
              key={range.kind}
              href={range.href}
              aria-current={period.kind === range.kind ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center rounded-pill border px-4 py-2 text-sm font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
                period.kind === range.kind
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-surface text-fg hover:bg-surface-2',
              )}
            >
              {range.label}
            </Link>
          ))}
          <span className={cn(
            'inline-flex min-h-11 items-center rounded-pill border px-4 py-2 text-sm font-semibold',
            period.kind === 'period'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-surface-2 text-fg-muted',
          )}>Период</span>
        </div>

        <form action="/delivery/control/analytics" method="get" className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <input type="hidden" name="range" value="period" />
          <label className="space-y-1.5 text-sm font-semibold text-fg">
            С даты
            <input type="date" name="from" defaultValue={formatDateInput(period.from)} className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-base text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1" required />
          </label>
          <label className="space-y-1.5 text-sm font-semibold text-fg">
            По дату
            <input type="date" name="to" defaultValue={formatDateInput(period.to)} className="min-h-11 w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-base text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1" required />
          </label>
          <button type="submit" className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]">
            Показать
          </button>
        </form>
      </section>

      <section aria-labelledby="delivery-metrics-title">
        <h2 id="delivery-metrics-title" className="sr-only">Показатели доставки</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
          <MetricCard label="Физические доставки" value={metrics.physicalDeliveries} icon={PackageCheck} tone="info" />
          <MetricCard label="Доставлено вовремя" value={metrics.onTime} icon={CheckCircle2} tone="success" />
          <MetricCard label="С опозданием" value={metrics.late} icon={AlarmClock} tone="danger" />
          <MetricCard label="Вовремя, %" value={numberValue(metrics.onTimePercent, '%')} icon={Gauge} tone="success" />
          <MetricCard label="Средняя задержка" value={numberValue(metrics.averageDelayMinutes, ' мин')} icon={Clock3} tone="warning" />
          <MetricCard label="Максимальная задержка" value={numberValue(metrics.maxDelayMinutes, ' мин')} icon={Timer} tone="danger" />
          <MetricCard label="Overrides" value={metrics.overrides} icon={ShieldCheck} tone="warning" />
        </div>
      </section>

      <aside className="rounded-card border border-info/30 bg-info-bg p-4 text-sm leading-6 text-info-fg" aria-label="Как считается аналитика">
        <p className="font-bold">Статистика по курьерам собирается с запуска Delivery 2.0</p>
        <p className="mt-1">Точки без окна входят в физические доставки, но не в расчёт пунктуальности. InDrive входит только в общие показатели и не попадает в строки курьеров.</p>
      </aside>

      <section aria-labelledby="courier-analytics-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="courier-analytics-title" className="text-xl font-bold text-fg">По курьерам</h2>
          <span className="text-sm font-semibold text-fg-muted">{analytics.couriers.length}</span>
        </div>
        {analytics.couriers.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {analytics.couriers.map((courier) => <CourierAnalyticsCard key={courier.courierId} courier={courier} />)}
          </div>
        ) : (
          <div className="rounded-3xl border border-border bg-surface p-8 text-center shadow-[var(--shadow-card)]">
            <UsersRound className="mx-auto size-10 text-fg-muted" strokeWidth={1.75} aria-hidden="true" />
            <h2 className="mt-3 text-lg font-bold text-fg">Нет данных по курьерам</h2>
            <p className="mt-1 text-sm text-fg-muted">В выбранном периоде ещё нет завершённых штатных доставок Delivery 2.0.</p>
          </div>
        )}
      </section>
    </div>
  )
}
