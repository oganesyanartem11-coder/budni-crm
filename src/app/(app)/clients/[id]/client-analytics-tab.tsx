'use client'

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts'
import { TrendingUp, ShoppingCart, Coffee, XCircle, type LucideIcon } from 'lucide-react'
import { formatMoney, formatPortions, pluralize } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils/cn'
import type { ClientAnalytics } from '@/lib/db/queries/client-analytics'

const MEAL_TYPE_COLORS: Record<string, string> = {
  BREAKFAST: 'var(--color-warning)',
  LUNCH: 'var(--color-success)',
  DINNER: 'var(--color-info)',
}

interface Props {
  analytics: ClientAnalytics
}

export function ClientAnalyticsTab({ analytics }: Props) {
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly')
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
        <SummaryCard
          icon={XCircle}
          label="Отказы"
          value={`${analytics.cancelledRate}%`}
          hint={`${analytics.totalCancelled} отменено`}
          tone={analytics.cancelledRate > 15 ? 'warning' : analytics.cancelledRate > 5 ? 'neutral' : 'success'}
        />
      </div>

      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h3 className="text-base font-semibold">Динамика выручки</h3>
          <div className="flex gap-1 p-1 bg-bg rounded-pill">
            <PeriodToggle active={period === 'weekly'} onClick={() => setPeriod('weekly')} label="Недели" />
            <PeriodToggle active={period === 'monthly'} onClick={() => setPeriod('monthly')} label="Месяцы" />
          </div>
        </div>

        <div className="h-56 -ml-2 -mr-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 12, bottom: 5, left: 12 }}>
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
                stroke="var(--color-accent)"
                strokeWidth={2.5}
                dot={{ fill: 'var(--color-accent)', r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {analytics.mealTypes.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h3 className="text-base font-semibold mb-4">Структура заказов</h3>
          <div className="h-32 -ml-2 -mr-2 mb-3">
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
                <Bar dataKey="portions" radius={[0, 6, 6, 0]}>
                  {analytics.mealTypes.map((mt) => (
                    <Cell key={mt.mealType} fill={MEAL_TYPE_COLORS[mt.mealType]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
            {analytics.mealTypes.map((mt) => (
              <div key={mt.mealType} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-bg/40">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: MEAL_TYPE_COLORS[mt.mealType] }}
                  />
                  <span className="truncate font-medium">{MEAL_TYPE_LABELS[mt.mealType]}</span>
                </span>
                <span className="text-fg-muted tabular-nums shrink-0 text-xs">
                  {formatMoney(mt.revenue)}
                </span>
              </div>
            ))}
          </div>
        </div>
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
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
    </div>
  )
}

function PeriodToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
        active ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}
