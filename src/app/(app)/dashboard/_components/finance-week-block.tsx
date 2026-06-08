'use client'

import { useId, useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { TrendingUp, TrendingDown, Minus, Calendar } from 'lucide-react'
import { AreaChart, Area, Tooltip, ResponsiveContainer } from 'recharts'
import type { AdminDashboardData, PeriodMargin } from '@/lib/db/queries/dashboard-stats'
import { formatMoney, formatDateRangeRu } from '@/lib/utils/format'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'
import { cn } from '@/lib/utils/cn'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion'

type FinancePreset =
  | 'today'
  | 'yesterday'
  | 'week_to_date'
  | 'month_rolling'
  | 'last_3_months'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'last_week'
  | 'last_month'
  | 'last_quarter'
  | 'this_year'
  | 'custom'

// Сегмент Вчера/Сегодня/Нед/Мес/3 мес — ровно эти пять значений (7.46:
// rolling-окна week_to_date/month_rolling/last_3_months вместо календарных).
type SegmentPreset = 'yesterday' | 'today' | 'week_to_date' | 'month_rolling' | 'last_3_months'
const SEGMENT_KEYS: SegmentPreset[] = ['yesterday', 'today', 'week_to_date', 'month_rolling', 'last_3_months']

interface Props {
  data: AdminDashboardData
  /** Маржа за тот же период. null → нет данных/нет доступа → fallback «—». */
  margin?: PeriodMargin | null
  preset: FinancePreset
  /** Для preset='custom' — границы из URL (YYYY-MM-DD), для отображения/префилла. */
  customFrom?: string
  customTo?: string
  isAdminLikeUser: boolean
}

const PERIOD_TABS: Array<{ key: SegmentPreset; label: string; aria: string }> = [
  { key: 'yesterday', label: 'Вчера', aria: 'Вчера' },
  { key: 'today', label: 'Сегодня', aria: 'Сегодня' },
  { key: 'week_to_date', label: 'Нед', aria: 'Неделя по сегодня' },
  { key: 'month_rolling', label: 'Мес', aria: 'Месяц по сегодня' },
  { key: 'last_3_months', label: '3 мес', aria: 'Три месяца по сегодня' },
]

// Пресеты в поповере «Период» (Bug 7.24-4). Значения = ReportPreset, считаются
// на сервере через getPresetRange — бэкенд уже готов.
const PICKER_PRESETS: Array<{ value: FinancePreset; label: string }> = [
  { value: 'yesterday', label: 'Вчера' },
  { value: 'last_week', label: 'Прошлая неделя' },
  { value: 'last_month', label: 'Прошлый месяц' },
  { value: 'last_quarter', label: 'Прошлый квартал' },
  { value: 'this_year', label: 'Этот год' },
]

export function FinanceWeekBlock({ data, margin, preset, customFrom, customTo, isAdminLikeUser }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const prefersReducedMotion = usePrefersReducedMotion()
  const gradientId = useId()

  function applyPeriod(next: FinancePreset) {
    if (next === preset && next !== 'custom') return
    const params = new URLSearchParams(searchParams.toString())
    // Любой пресет (кроме custom) сбрасывает custom-границы.
    params.delete('from')
    params.delete('to')
    // 7.45: дефолт без ?period= = today (см. page.tsx). Поэтому каждый пресет
    // пишем явно — включая this_week. Раньше this_week удалял param и
    // проваливался в today-дефолт, из-за чего «Нед» не нажималась.
    params.set('period', next)
    const qs = params.toString()
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }

  function applyCustomRange(from: string, to: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('period', 'custom')
    params.set('from', from)
    params.set('to', to)
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
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

  // Подпись с конкретным диапазоном дат под переключателем периода (F-1).
  // today/yesterday — без подписи (период очевиден). custom — границы из URL.
  // Остальные пресеты — диапазон из getPresetRange (MSK-окна, считается на
  // клиенте; week.ts client-safe). Все FinancePreset входят в ReportPreset.
  const rangeLabel = (() => {
    if (preset === 'today' || preset === 'yesterday') return null
    if (preset === 'custom') {
      if (!customFrom || !customTo) return null
      // 'YYYY-MM-DD' → МСК-полдень того же дня (T09:00Z), чтобы формат прочитал
      // верный МСК-календарный день вне зависимости от TZ.
      return formatDateRangeRu(new Date(`${customFrom}T09:00:00.000Z`), new Date(`${customTo}T09:00:00.000Z`))
    }
    const { from, to } = getPresetRange(preset as ReportPreset)
    return formatDateRangeRu(from, to)
  })()

  return (
    <section
      className="rounded-3xl border border-border bg-surface p-7"
      style={{ boxShadow: 'var(--shadow-card)' }}
      aria-label="Финансы за период"
    >
      {/* Header — заголовок сверху, контролы отдельной строкой снизу (Bug 7.24-2:
          раньше flex-wrap + длинный заголовок «этого квартала» ронял SegmentedControl вниз). */}
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-fg-muted">
          Финансы
        </h2>

        {/* Сегментированный переключатель Нед/Мес/Кв (+ date-range picker — Bug 7.24-4) */}
        <div className="flex items-center gap-2 flex-wrap">
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
          <FinancePicker
            preset={preset}
            customFrom={customFrom}
            customTo={customTo}
            disabled={isPending}
            onPreset={applyPeriod}
            onCustom={applyCustomRange}
          />
        </div>

        {/* Конкретный диапазон дат выбранного периода (F-1) — мелким серым. */}
        {rangeLabel && <p className="-mt-2 text-[13px] text-fg-muted">{rangeLabel}</p>}
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
            <span className="font-display text-4xl font-bold tabular-nums text-fg-strong sm:text-5xl">
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
          {/* Волна 4: сервисная выручка (доставка) — ненавязчивой строкой, только если > 0.
              food-выручка выше не меняется; это отдельный поток, в маржу не входит. */}
          {data.thisPeriod.deliveryRevenue > 0 && (
            <p className="mt-1.5 text-xs text-data-revenue-ink/80">
              Сервисная выручка (доставка): {formatMoney(data.thisPeriod.deliveryRevenue)}
            </p>
          )}
        </div>

        {/* 2. МАРЖА — только admin-like. MANAGER НЕ видит. */}
        {isAdminLikeUser && (
          <div className="rounded-2xl bg-data-margin-bg p-5">
            <p className="text-[11px] font-bold uppercase tracking-widest text-data-margin-ink">Маржа</p>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3">
              {margin ? (
                <span className="font-display text-2xl font-extrabold tabular-nums text-fg-strong sm:text-3xl">
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

/* ─────────────────────────────────────────────────────────────
   Date-range picker (Bug 7.24-4). Кнопка «Период» рядом с сегментом
   Нед/Мес/Кв; открывает поповер с пресетами (Вчера / Прошлая неделя /
   …/ Этот год) + произвольный диапазон от/до. Навигация через URL
   (?period=…&from&to) — бэкенд (getAdminDashboardData/getPresetRange)
   уже принимает границы. Серверные queries НЕ менялись.
   ───────────────────────────────────────────────────────────── */
function shortDate(iso?: string): string {
  // 'YYYY-MM-DD' → 'DD.MM'
  if (!iso || iso.length < 10) return ''
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`
}

function FinancePicker({
  preset,
  customFrom,
  customTo,
  disabled,
  onPreset,
  onCustom,
}: {
  preset: FinancePreset
  customFrom?: string
  customTo?: string
  disabled: boolean
  onPreset: (value: FinancePreset) => void
  onCustom: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(customFrom ?? '')
  const [to, setTo] = useState(customTo ?? '')

  const isActive = !SEGMENT_KEYS.includes(preset as SegmentPreset)
  const activePreset = PICKER_PRESETS.find((p) => p.value === preset)
  const label =
    preset === 'custom' && customFrom && customTo
      ? `${shortDate(customFrom)}–${shortDate(customTo)}`
      : activePreset?.label ?? 'Период'

  const customValid = Boolean(from && to && from <= to)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Выбрать период"
          style={
            isActive
              ? { background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }
              : undefined
          }
          className={cn(
            'inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-pill text-sm font-semibold transition-colors disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1',
            isActive
              ? 'bg-primary text-primary-foreground'
              : 'bg-surface-2 text-fg-muted hover:text-fg',
          )}
        >
          <Calendar className="h-4 w-4" aria-hidden="true" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-0.5">
          {PICKER_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                onPreset(p.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center rounded-lg px-3 py-2 text-sm transition-colors text-left',
                preset === p.value ? 'bg-surface-2 font-semibold text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="my-2 border-t border-border" />

        <div className="space-y-2 px-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Произвольно</p>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="От"
              className="min-h-[40px] flex-1 min-w-0 rounded-lg border border-border bg-surface px-2 text-xs focus:outline-none focus:border-primary"
            />
            <span className="text-fg-muted">→</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              aria-label="До"
              className="min-h-[40px] flex-1 min-w-0 rounded-lg border border-border bg-surface px-2 text-xs focus:outline-none focus:border-primary"
            />
          </div>
          <button
            type="button"
            disabled={!customValid || disabled}
            onClick={() => {
              if (!customValid) return
              onCustom(from, to)
              setOpen(false)
            }}
            style={
              customValid
                ? { background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }
                : undefined
            }
            className={cn(
              'inline-flex w-full items-center justify-center min-h-[44px] rounded-pill text-sm font-semibold transition-opacity',
              customValid ? 'bg-primary text-primary-foreground hover:opacity-95' : 'bg-surface-2 text-fg-faint cursor-not-allowed',
            )}
          >
            Применить
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
