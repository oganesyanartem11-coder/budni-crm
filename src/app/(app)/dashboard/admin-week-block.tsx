'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Trophy,
  ChevronRight,
  Calendar,
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatMoney, formatOrders, formatPortions } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { AdminDashboardData } from '@/lib/db/queries/dashboard-stats'
import type { ReportPreset } from '@/lib/utils/week'

interface Props {
  data: AdminDashboardData
  preset: ReportPreset
  periodLabel: string
  customFromIso?: string
  customToIso?: string
}

const PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'this_week', label: 'Эта неделя' },
  { key: 'last_week', label: 'Прошлая' },
  { key: 'this_month', label: 'Месяц' },
  { key: 'this_year', label: 'Год' },
  { key: 'custom', label: 'Произвольно' },
]

function formatRange(fromIso: string, toIso: string): string {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${from.getDate()}.${pad(from.getMonth() + 1)} – ${to.getDate()}.${pad(to.getMonth() + 1)}`
}

export function AdminWeekBlock({ data, preset, periodLabel, customFromIso, customToIso }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const rangeFrom = new Date(data.rangeFrom)
  const rangeTo = new Date(data.rangeTo)
  const rangeLabel = formatRange(data.rangeFrom, data.rangeTo)

  const initialFrom = (customFromIso ?? data.rangeFrom).slice(0, 10)
  const initialTo = (customToIso ?? data.rangeTo).slice(0, 10)
  const [customFrom, setCustomFrom] = useState(initialFrom)
  const [customTo, setCustomTo] = useState(initialTo)

  function applyPreset(p: ReportPreset) {
    const url = new URL(window.location.href)
    url.searchParams.delete('from')
    url.searchParams.delete('to')
    if (p === 'this_week') {
      url.searchParams.delete('period')
    } else {
      url.searchParams.set('period', p)
    }
    startTransition(() => router.push(`${pathname}?${url.searchParams.toString()}`))
  }

  function applyCustom() {
    const url = new URL(window.location.href)
    url.searchParams.set('period', 'custom')
    url.searchParams.set('from', customFrom)
    url.searchParams.set('to', customTo)
    startTransition(() => router.push(`${pathname}?${url.searchParams.toString()}`))
  }

  // «Открыть в отчётах» — прокидываем тот же preset/from/to.
  // Контракт /reports: ?preset=...&from=YYYY-MM-DD&to=YYYY-MM-DD
  const reportsHref = (() => {
    const sp = new URLSearchParams()
    sp.set('preset', preset)
    if (preset === 'custom') {
      sp.set('from', rangeFrom.toISOString().slice(0, 10))
      sp.set('to', rangeTo.toISOString().slice(0, 10))
    }
    return `/reports?${sp.toString()}`
  })()

  const hasChartData = data.thisPeriod.daily.filter((d) => d.revenue > 0).length >= 3
  const tooLongForChart = data.thisPeriod.daily.length === 0

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">Финансы</h2>
        <Link
          href={reportsHref}
          className="text-xs text-fg-subtle hover:text-fg inline-flex items-center gap-1 transition-colors group"
        >
          {periodLabel} · {rangeLabel}
          <ChevronRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      {/* Переключатель пресетов периода */}
      <div className="rounded-2xl bg-surface border border-border p-3 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              disabled={isPending}
              className={cn(
                'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors disabled:opacity-50',
                preset === p.key ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
            <Calendar className="w-4 h-4 text-fg-muted shrink-0" />
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
            />
            <span className="text-fg-muted text-sm">→</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
            />
            <button
              type="button"
              onClick={applyCustom}
              disabled={isPending}
              className="px-4 py-2 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Применить
            </button>
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
          <div>
            <p className="text-xs text-fg-muted">Выручка</p>
            <p className="text-3xl font-bold tabular-nums mt-1">{formatMoney(data.thisPeriod.totalRevenue)}</p>
            <p className="text-xs text-fg-muted mt-0.5">
              {formatOrders(data.thisPeriod.totalOrders)} · {formatPortions(data.thisPeriod.totalPortions)}
            </p>
          </div>
          {data.wow && (
            <WoWIndicator wow={data.wow} />
          )}
        </div>

        <div className="h-40 -ml-2 -mr-2">
          {tooLongForChart ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
              <TrendingUp className="w-12 h-12 text-fg-subtle" strokeWidth={1.25} />
              <p className="text-xs text-fg-muted max-w-xs">
                Период слишком длинный для дневного графика — откройте отчёты для агрегированного вида
              </p>
            </div>
          ) : !hasChartData ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
              <TrendingUp className="w-12 h-12 text-fg-subtle" strokeWidth={1.25} />
              <p className="text-xs text-fg-muted max-w-xs">
                Данные накапливаются — график появится когда будет минимум 3 дня заказов
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.thisPeriod.daily} margin={{ top: 5, right: 12, bottom: 5, left: 12 }}>
                <XAxis
                  dataKey="dayLabel"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'var(--color-fg-muted)', fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '12px',
                    fontSize: '12px',
                    boxShadow: 'var(--shadow-popover)',
                  }}
                  formatter={(value) => [formatMoney(Number(value)), 'Выручка']}
                  labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="var(--color-accent)"
                  strokeWidth={2.5}
                  dot={{ fill: 'var(--color-accent)', r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {data.topClients.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-warning-fg" />
              <p className="text-sm font-semibold">Топ клиенты периода</p>
            </div>
          </div>
          <ul className="space-y-2">
            {data.topClients.map((c, i) => (
              <li key={c.clientId}>
                <Link
                  href={`/clients/${c.clientId}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-bg/50 transition-colors group"
                >
                  <div className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
                    i === 0 && 'bg-warning-bg text-warning-fg',
                    i === 1 && 'bg-neutral-bg text-neutral-fg',
                    i === 2 && 'bg-info-bg text-info-fg',
                  )}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{c.clientName}</p>
                    <p className="text-xs text-fg-muted">{formatOrders(c.ordersCount)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold tabular-nums whitespace-nowrap">{formatMoney(c.revenue)}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-fg-subtle group-hover:text-fg-muted transition-colors" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function WoWIndicator({ wow }: { wow: NonNullable<AdminDashboardData['wow']> }) {
  if (wow.changePct === null || wow.comparePrevRevenue === 0) {
    return (
      <div className="text-xs text-fg-subtle">
        Сравнение появится со следующей недели
      </div>
    )
  }

  const isUp = wow.changePct > 0
  const isFlat = Math.abs(wow.changePct) < 0.1
  const subLabel = wow.prorated
    ? `vs прошл. неделя · дни 1–${wow.daysCompared}`
    : 'vs прошл. неделя'

  return (
    <div className="flex flex-col items-end gap-1">
      <div className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-medium',
        isFlat ? 'bg-bg text-fg-muted' :
        isUp ? 'bg-success-bg text-success-fg' :
        'bg-danger-bg/40 text-danger-fg'
      )}>
        {isFlat ? <Minus className="w-3 h-3" /> : isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        {isFlat ? 'на уровне' : `${isUp ? '+' : ''}${wow.changePct}%`}
      </div>
      <span className="text-xs text-fg-subtle">{subLabel}</span>
    </div>
  )
}
