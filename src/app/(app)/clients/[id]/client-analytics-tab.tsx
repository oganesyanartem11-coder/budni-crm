'use client'

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts'
import { TrendingUp, ShoppingCart, Coffee, MapPin, type LucideIcon } from 'lucide-react'
import { formatMoney, formatPortions, formatOrders, pluralize } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { EmptyState } from '@/components/ui/empty-state'
import { ChartCard } from '@/components/charts/chart-card'
import { cn } from '@/lib/utils/cn'
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion'
import type { ClientAnalytics } from '@/lib/db/queries/client-analytics'

const MEAL_TYPE_COLORS: Record<string, string> = {
  BREAKFAST: 'var(--color-brand-yellow)',
  LUNCH: 'var(--color-brand-green)',
  DINNER: 'var(--color-info)',
}

interface Props {
  analytics: ClientAnalytics
}

export function ClientAnalyticsTab({ analytics }: Props) {
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly')
  const prefersReducedMotion = usePrefersReducedMotion()
  const data = period === 'weekly' ? analytics.weekly : analytics.monthly

  const hasData = analytics.totalOrders > 0

  if (!hasData) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Нет данных за последний год"
        description="Аналитика появится когда у клиента будут заказы."
      />
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <SummaryCard
          icon={TrendingUp}
          label="Выручка за год"
          value={formatMoney(analytics.totalRevenue)}
          tone="info"
        />
        <SummaryCard
          icon={ShoppingCart}
          label="Заказов"
          value={analytics.totalOrders.toString()}
          hint={formatPortions(analytics.totalPortions)}
        />
        <SummaryCard
          icon={Coffee}
          label="Средний чек"
          value={formatMoney(analytics.averageOrder)}
          hint={`~${Math.round(analytics.averagePortions)} ${pluralize(Math.round(analytics.averagePortions), ['порция', 'порции', 'порций'])} / заказ`}
        />
      </div>

      <ChartCard
        title={<span className="font-display text-base font-bold text-fg-strong">Динамика выручки</span>}
        action={
          <div role="group" aria-label="Период" className="inline-flex items-center gap-0.5 p-0.5 bg-bg border border-border rounded-pill">
            <PeriodToggle active={period === 'weekly'} onClick={() => setPeriod('weekly')} label="Недели" />
            <PeriodToggle active={period === 'monthly'} onClick={() => setPeriod('monthly')} label="Месяцы" />
          </div>
        }
        height="auto"
        bodyClassName="h-56 -ml-2 -mr-2"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 12, bottom: 5, left: 12 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
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
                if (name === 'revenue') return [formatMoney(num), 'Выручка']
                if (name === 'orders') return [num.toString(), 'Заказов']
                return [num.toString(), String(name ?? '')]
              }}
              labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
            />
            <Line
              type="monotone"
              dataKey="revenue"
              stroke="var(--color-brand-green)"
              strokeWidth={2.5}
              dot={{ fill: 'var(--color-brand-green)', r: 3 }}
              activeDot={{ r: 5 }}
              isAnimationActive={!prefersReducedMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {analytics.locations.length >= 2 && (() => {
        const totalLocRevenue = analytics.locations.reduce((s, l) => s + l.revenue, 0)
        return (
          <ChartCard
            title={
              <span className="font-display text-base font-bold text-fg-strong flex items-center gap-2">
                <MapPin className="w-4 h-4 text-brand-green" />
                Разбивка по точкам доставки
              </span>
            }
            height="auto"
            bodyClassName="mt-1"
          >
            <div className="grid grid-cols-1 gap-2 text-sm">
              {analytics.locations.map((loc) => {
                const sharePct = totalLocRevenue > 0 ? Math.round((loc.revenue / totalLocRevenue) * 100) : 0
                return (
                  <div
                    key={loc.locationId}
                    className="relative flex items-center justify-between gap-3 pl-4 pr-3 py-2.5 rounded-xl bg-surface-2"
                  >
                    <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand-green" aria-hidden="true" />
                    <span className="font-medium truncate min-w-0 text-fg">{loc.locationName}</span>
                    <span className="flex items-center gap-3 text-xs text-fg-muted tabular-nums shrink-0">
                      <span className="font-display font-bold text-fg-strong">{formatMoney(loc.revenue)}</span>
                      <span>{loc.portions} порц.</span>
                      <span>{formatOrders(loc.ordersCount)}</span>
                      <span className="text-fg-subtle">{sharePct}%</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </ChartCard>
        )
      })()}

      {analytics.mealTypes.length > 0 && (
        <ChartCard
          title={<span className="font-display text-base font-bold text-fg-strong">Структура заказов</span>}
          height="auto"
          bodyClassName="h-32 -ml-2 -mr-2"
          footer={
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
              {analytics.mealTypes.map((mt) => (
                <div key={mt.mealType} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-surface-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: MEAL_TYPE_COLORS[mt.mealType] }}
                    />
                    <span className="truncate font-medium text-fg">{MEAL_TYPE_LABELS[mt.mealType]}</span>
                  </span>
                  <span className="text-fg-muted tabular-nums shrink-0 text-xs font-display font-bold">
                    {formatMoney(mt.revenue)}
                  </span>
                </div>
              ))}
            </div>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analytics.mealTypes} margin={{ top: 5, right: 12, bottom: 5, left: 12 }} layout="vertical">
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="mealType"
                axisLine={false}
                tickLine={false}
                width={70}
                tick={(props) => {
                  const { x, y, payload } = props as { x: number | string; y: number | string; payload?: { value?: string } }
                  const value = payload?.value
                  return (
                    <text x={x} y={y} dy={4} textAnchor="end" fill="var(--color-fg-muted)" fontSize={12}>
                      {value ? MEAL_TYPE_LABELS[value as 'BREAKFAST' | 'LUNCH' | 'DINNER'] : ''}
                    </text>
                  )
                }}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '12px',
                  fontSize: '12px',
                }}
                formatter={(value) => [Number(value).toString(), 'Порций']}
              />
              <Bar dataKey="portions" radius={[0, 6, 6, 0]} isAnimationActive={!prefersReducedMotion}>
                {analytics.mealTypes.map((mt) => (
                  <Cell key={mt.mealType} fill={MEAL_TYPE_COLORS[mt.mealType]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
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
    info: 'bg-info-bg border-info/20',
    warning: 'bg-warning-bg border-warning/20',
    success: 'bg-success-bg border-success/20',
  }
  return (
    <div className={cn('rounded-2xl border p-4', toneClasses[tone])} style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-[11px] font-medium uppercase tracking-widest text-fg-muted">{label}</p>
        <Icon className="w-3.5 h-3.5 text-fg-subtle shrink-0" aria-hidden="true" />
      </div>
      <p className="font-display text-2xl font-bold tabular-nums text-fg-strong">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-0.5 tabular-nums">{hint}</p>}
    </div>
  )
}

function PeriodToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ touchAction: 'manipulation' }}
      className={cn(
        'min-h-[44px] rounded-pill px-3 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        active ? 'bg-brand-green-deep text-surface' : 'text-fg-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}
