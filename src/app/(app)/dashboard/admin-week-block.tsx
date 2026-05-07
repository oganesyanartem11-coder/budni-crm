'use client'

import Link from 'next/link'
import { TrendingUp, TrendingDown, Minus, Trophy, ChevronRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { formatMoney } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { AdminDashboardData } from '@/lib/db/queries/dashboard-stats'

interface Props {
  data: AdminDashboardData
}

const MEAL_TYPE_COLORS: Record<string, string> = {
  BREAKFAST: 'var(--color-warning)',
  LUNCH: 'var(--color-success)',
  DINNER: 'var(--color-info)',
}

export function AdminWeekBlock({ data }: Props) {
  const weekFrom = new Date(data.weekFrom)
  const weekTo = new Date(data.weekTo)
  const weekLabel = `${weekFrom.getDate()}.${(weekFrom.getMonth() + 1).toString().padStart(2, '0')} – ${weekTo.getDate()}.${(weekTo.getMonth() + 1).toString().padStart(2, '0')}`

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm uppercase tracking-wider text-fg-muted font-medium">Финансовая неделя</h2>
        <span className="text-xs text-fg-subtle">Пт–Чт · {weekLabel}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
            <div>
              <p className="text-xs text-fg-muted">Выручка недели</p>
              <p className="text-3xl font-bold tabular-nums mt-1">{formatMoney(data.thisWeek.totalRevenue)}</p>
              <p className="text-xs text-fg-muted mt-0.5">
                {data.thisWeek.totalOrders} заказов · {data.thisWeek.totalPortions} порций
              </p>
            </div>
            <ChangeIndicator
              changePct={data.revenueChangePct}
              prevRevenue={data.prevWeek.totalRevenue}
            />
          </div>

          <div className="h-40 -ml-2 -mr-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.thisWeek.daily} margin={{ top: 5, right: 12, bottom: 5, left: 12 }}>
                <XAxis
                  dataKey="dayLabel"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'var(--color-fg-muted)', fontSize: 11 }}
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
          </div>
        </div>

        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <p className="text-xs text-fg-muted mb-3">По типам питания</p>
          {data.mealTypes.length === 0 ? (
            <div className="text-center text-fg-muted text-sm py-12">Нет данных</div>
          ) : (
            <>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.mealTypes}
                      dataKey="portions"
                      cx="50%"
                      cy="50%"
                      innerRadius={28}
                      outerRadius={50}
                      paddingAngle={2}
                    >
                      {data.mealTypes.map((entry) => (
                        <Cell key={entry.mealType} fill={MEAL_TYPE_COLORS[entry.mealType]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: '12px',
                        fontSize: '12px',
                      }}
                      formatter={(value, _name, item) => {
                        const payload = (item as { payload?: { mealType?: string } } | undefined)?.payload
                        const mt = payload?.mealType
                        return [`${Number(value)} порций`, mt ? MEAL_TYPE_LABELS[mt as keyof typeof MEAL_TYPE_LABELS] : '']
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="space-y-1.5 mt-3 text-sm">
                {data.mealTypes.map((mt) => (
                  <li key={mt.mealType} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: MEAL_TYPE_COLORS[mt.mealType] }}
                      />
                      <span className="truncate">{MEAL_TYPE_LABELS[mt.mealType]}</span>
                    </span>
                    <span className="text-fg-muted tabular-nums shrink-0">{mt.portions}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {data.topClients.length > 0 && (
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-warning-fg" />
              <p className="text-sm font-semibold">Топ клиенты недели</p>
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
                    <p className="text-xs text-fg-muted">{c.ordersCount} заказов</p>
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

function ChangeIndicator({ changePct, prevRevenue }: { changePct: number | null; prevRevenue: number }) {
  if (changePct === null || prevRevenue === 0) {
    return (
      <div className="text-xs text-fg-subtle">
        Прошлая неделя: нет данных
      </div>
    )
  }

  const isUp = changePct > 0
  const isFlat = Math.abs(changePct) < 0.1

  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-xs font-medium',
      isFlat ? 'bg-bg text-fg-muted' :
      isUp ? 'bg-success-bg text-success-fg' :
      'bg-danger-bg/40 text-danger-fg'
    )}>
      {isFlat ? <Minus className="w-3 h-3" /> : isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {isFlat ? 'на уровне' : `${isUp ? '+' : ''}${changePct}%`}
      <span className="text-fg-subtle ml-1 font-normal">vs пред. неделя</span>
    </div>
  )
}
