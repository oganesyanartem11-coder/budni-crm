'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Calendar, TrendingUp, ShoppingCart, Clock, Printer, Trophy, ChevronRight, ChevronDown, type LucideIcon } from 'lucide-react'
import { formatMoney, formatPortions, formatOrders } from '@/lib/utils/format'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils/cn'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import type { FinancialReport } from '@/lib/db/queries/reports'
import type { ReportPreset } from '@/lib/utils/week'

interface Props {
  preset: ReportPreset
  rangeFromIso: string
  rangeToIso: string
  report: FinancialReport
}

const MAIN_PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'this_week', label: 'Эта неделя' },
  { key: 'this_month', label: 'Этот месяц' },
  { key: 'this_year', label: 'Год' },
]

const SECONDARY_PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'yesterday', label: 'Вчера' },
  { key: 'last_week', label: 'Прошлая неделя' },
  { key: 'last_month', label: 'Прошлый месяц' },
  { key: 'this_quarter', label: 'Квартал' },
  { key: 'custom', label: 'Произвольно' },
]

export function ReportsView({ preset, rangeFromIso, rangeToIso, report }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const fromDate = rangeFromIso.slice(0, 10)
  const toDate = rangeToIso.slice(0, 10)

  const [customFrom, setCustomFrom] = useState(fromDate)
  const [customTo, setCustomTo] = useState(toDate)

  function applyPreset(p: ReportPreset) {
    const url = new URL(window.location.href)
    url.searchParams.delete('from')
    url.searchParams.delete('to')
    url.searchParams.set('preset', p)
    startTransition(() => router.push(`${pathname}?${url.searchParams.toString()}`))
  }

  function applyCustom() {
    const url = new URL(window.location.href)
    url.searchParams.set('preset', 'custom')
    url.searchParams.set('from', customFrom)
    url.searchParams.set('to', customTo)
    startTransition(() => router.push(`${pathname}?${url.searchParams.toString()}`))
  }

  const hasData = report.totalOrders > 0

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3 no-print" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-wrap gap-1.5">
            {MAIN_PRESETS.map((p) => (
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
            <SecondaryPresetMenu
              preset={preset}
              onSelect={applyPreset}
              disabled={isPending}
            />
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="px-4 py-2 rounded-pill border border-border-strong bg-surface text-fg font-medium text-xs hover:bg-bg transition-colors flex items-center gap-2"
          >
            <Printer className="w-3.5 h-3.5" />
            Печать
          </button>
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

      {!hasData ? (
        <EmptyState
          icon={Calendar}
          title="Нет данных в этом периоде"
          description="Попробуйте другой диапазон."
        />
      ) : (
        <div className="print-area space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard icon={TrendingUp} label="Выручка" value={formatMoney(report.totalRevenue)} tone="info" />
            <SummaryCard icon={ShoppingCart} label="Заказов" value={report.totalOrders.toString()} hint={formatPortions(report.totalPortions)} />
            <SummaryCard icon={Clock} label="Средний чек" value={formatMoney(report.averageOrder)} hint="за заказ" />
            <SummaryCard icon={Calendar} label="В день в среднем" value={formatMoney(report.averagePerDay)} hint={`${report.daysInPeriod} дн.`} />
          </div>

          <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
            <h3 className="text-base font-semibold mb-4">Динамика по дням</h3>
            <div className="h-64 -ml-2 -mr-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={report.daily} margin={{ top: 5, right: 12, bottom: 5, left: 12 }}>
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: 'var(--color-fg-muted)', fontSize: 10 }}
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
                    formatter={(value, name) => {
                      const num = Number(value)
                      const n = String(name ?? '')
                      if (n === 'revenue') return [formatMoney(num), 'Выручка']
                      return [num.toString(), n]
                    }}
                    labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="var(--color-accent)"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {report.clients.length > 0 && (
            <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-4 h-4 text-warning-fg" />
                <h3 className="text-base font-semibold">Клиенты периода ({report.clients.length})</h3>
              </div>
              <ul className="divide-y divide-border">
                {report.clients.slice(0, 10).map((c, i) => (
                  <li key={c.clientId}>
                    <Link
                      href={`/clients/${c.clientId}`}
                      className="flex items-center gap-3 py-2.5 px-2 rounded-xl hover:bg-bg/50 transition-colors group"
                    >
                      <div className="w-7 h-7 rounded-full bg-bg flex items-center justify-center text-xs font-bold text-fg-muted shrink-0">
                        {i + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate text-sm">{c.clientName}</p>
                        <p className="text-xs text-fg-muted">{formatOrders(c.ordersCount)} · {formatPortions(c.portions)}</p>
                      </div>
                      <p className="font-semibold tabular-nums whitespace-nowrap text-sm">{formatMoney(c.revenue)}</p>
                      <ChevronRight className="w-3.5 h-3.5 text-fg-subtle group-hover:text-fg-muted transition-colors no-print" />
                    </Link>
                  </li>
                ))}
              </ul>
              {report.clients.length > 10 && (
                <p className="text-xs text-fg-subtle mt-3 text-center no-print">
                  Показаны первые 10 из {report.clients.length}
                </p>
              )}
            </div>
          )}

          <div className="text-xs text-fg-subtle text-center pt-2 print-only">
            Сформировано: {new Date().toLocaleString('ru-RU')} · Будни CRM
          </div>
        </div>
      )}
    </div>
  )
}

function SecondaryPresetMenu({
  preset,
  onSelect,
  disabled,
}: {
  preset: ReportPreset
  onSelect: (p: ReportPreset) => void
  disabled: boolean
}) {
  const activeSecondary = SECONDARY_PRESETS.find((p) => p.key === preset)
  const label = activeSecondary?.label ?? 'Другой период'
  const isActive = !!activeSecondary

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1',
            isActive ? 'bg-accent text-accent-fg' : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
          )}
        >
          {label}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {SECONDARY_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.key}
            onClick={() => onSelect(p.key)}
            className={cn('cursor-pointer', preset === p.key && 'font-semibold')}
          >
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: LucideIcon
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'info' | 'warning' | 'success'
}) {
  const toneClasses = {
    neutral: 'bg-surface border-border',
    info: 'bg-info-bg/30 border-info/20',
    warning: 'bg-warning-bg/30 border-warning/20',
    success: 'bg-success-bg/30 border-success/20',
  }
  return (
    <div className={cn('rounded-2xl border p-4', toneClasses[tone])} style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-xs text-fg-muted">{label}</p>
        <Icon className="w-3.5 h-3.5 text-fg-subtle shrink-0" />
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
    </div>
  )
}
