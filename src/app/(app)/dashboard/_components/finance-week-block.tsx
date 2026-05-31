'use client'

import { useId, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { AreaChart, Area, Tooltip, ResponsiveContainer } from 'recharts'
import type { AdminDashboardData, PeriodMargin } from '@/lib/db/queries/dashboard-stats'
import { formatMoney } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion'

type FinancePreset = 'this_week' | 'this_month' | 'this_quarter'

interface Props {
  data: AdminDashboardData
  /** Маржа за тот же период. null → нет данных/нет доступа → fallback «—». */
  margin?: PeriodMargin | null
  preset: FinancePreset
  isAdminLikeUser: boolean
}

const PERIOD_TABS: Array<{ key: FinancePreset; label: string; aria: string }> = [
  { key: 'this_week', label: 'Нед', aria: 'Эта неделя' },
  { key: 'this_month', label: 'Мес', aria: 'Этот месяц' },
  { key: 'this_quarter', label: 'Кв', aria: 'Этот квартал' },
]

const PERIOD_TITLE: Record<FinancePreset, string> = {
  this_week: 'этой недели',
  this_month: 'этого месяца',
  this_quarter: 'этого квартала',
}

export function FinanceWeekBlock({ data, margin, preset, isAdminLikeUser }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const prefersReducedMotion = usePrefersReducedMotion()
  const gradientId = useId()

  function applyPeriod(next: FinancePreset) {
    if (next === preset) return
    const params = new URLSearchParams(searchParams.toString())
    // 'this_week' — дефолт: убираем параметр; иначе пишем.
    if (next === 'this_week') {
      params.delete('period')
    } else {
      params.set('period', next)
    }
    const qs = params.toString()
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }

  const daily = data.thisPeriod.daily
  const hasDaily = daily.length > 0

  // Stat-строка (лучший/средний день) — только если есть daily.
  const bestDay = hasDaily ? Math.max(...daily.map((d) => d.revenue)) : 0
  const avgDay = hasDaily
    ? Math.round(daily.reduce((sum, d) => sum + d.revenue, 0) / daily.length)
    : 0

  const wowPct = data.wow?.changePct ?? null
  const hasWow = wowPct !== null
  const wowUp = hasWow && (wowPct as number) >= 0

  return (
    <section
      className="rounded-3xl border border-border bg-surface p-7"
      style={{ boxShadow: 'var(--shadow-card)' }}
      aria-label="Финансы за период"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-fg-muted">
          Финансы {PERIOD_TITLE[preset]}
        </h2>

        {/* Сегментированный переключатель Нед/Мес/Кв */}
        <SegmentedControl<FinancePreset>
          ariaLabel="Период"
          size="sm"
          value={preset}
          onChange={(next) => {
            if (isPending) return
            applyPeriod(next)
          }}
          options={PERIOD_TABS.map((tab) => ({ value: tab.key, label: tab.label }))}
        />
      </div>

      {/* Grid карточек */}
      <div
        className={cn(
          'mt-5 grid gap-4',
          isAdminLikeUser ? 'sm:grid-cols-2' : 'grid-cols-1',
        )}
      >
        {/* 1. ВЫРУЧКА — всегда видна */}
        <div className="rounded-2xl bg-data-revenue-bg p-5">
          <p className="text-[11px] font-bold uppercase tracking-widest text-data-revenue-ink">Выручка</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-2xl font-bold tabular-nums text-fg-strong sm:text-3xl">
              {formatMoney(data.thisPeriod.totalRevenue)}
            </span>
            {hasWow && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-3 py-1 rounded-pill text-xs font-bold tabular-nums',
                  Math.abs(wowPct as number) === 0
                    ? 'bg-neutral-bg text-neutral-fg'
                    : wowUp
                      ? 'bg-success-bg text-success-fg'
                      : 'bg-danger-bg text-danger-fg',
                )}
              >
                {Math.abs(wowPct as number) === 0 ? (
                  <Minus className="h-4 w-4" aria-hidden="true" />
                ) : wowUp ? (
                  <TrendingUp className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <TrendingDown className="h-4 w-4" aria-hidden="true" />
                )}
                {`${wowUp ? '+' : '−'}${Math.abs(wowPct as number)}%`}
              </span>
            )}
          </div>
        </div>

        {/* 2. МАРЖА — только admin-like. MANAGER НЕ видит. */}
        {isAdminLikeUser && (
          <div className="rounded-2xl bg-data-margin-bg p-5">
            <p className="text-[11px] font-bold uppercase tracking-widest text-data-margin-ink">Маржа</p>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
              {margin ? (
                <span className="font-display text-2xl font-extrabold tabular-nums text-fg-strong">
                  {margin.marginPct === null ? '—' : `${margin.marginPct}%`}
                </span>
              ) : (
                <span className="font-display text-2xl font-bold tabular-nums text-fg-subtle sm:text-3xl">—</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sparkline ИЛИ ничего (если daily пуст). */}
      {hasDaily && (
        <div className="mt-5">
          <div className="h-[60px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-data-revenue)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-data-revenue)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Tooltip
                  cursor={{ stroke: 'var(--color-border-strong)', strokeWidth: 1 }}
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '12px',
                    fontSize: '12px',
                    boxShadow: 'var(--shadow-popover)',
                  }}
                  labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
                  formatter={(value) => [formatMoney(Number(value)), 'Выручка']}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="var(--color-data-revenue)"
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={!prefersReducedMotion}
                  dot={false}
                  activeDot={{ r: 4, fill: 'var(--color-data-revenue)' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <p className="mt-2 text-xs text-fg-muted">
            Лучший день: <span className="font-medium tabular-nums text-fg">{formatMoney(bestDay)}</span>
            {' · '}
            Средний: <span className="font-medium tabular-nums text-fg">{formatMoney(avgDay)}</span>
          </p>
        </div>
      )}
    </section>
  )
}
