'use client'

import Link from 'next/link'
import { TrendingUp, TrendingDown, Minus, Trophy, ChevronRight } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatMoney, formatOrders, formatPortions } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import type { AdminDashboardData } from '@/lib/db/queries/dashboard-stats'

interface Props {
  data: AdminDashboardData
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

      <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
          <div>
            <p className="text-xs text-fg-muted">Выручка недели</p>
            <p className="text-3xl font-bold tabular-nums mt-1">{formatMoney(data.thisWeek.totalRevenue)}</p>
            <p className="text-xs text-fg-muted mt-0.5">
              {formatOrders(data.thisWeek.totalOrders)} · {formatPortions(data.thisWeek.totalPortions)}
            </p>
          </div>
          <ChangeIndicator
            changePct={data.revenueChangePct}
            prevRevenue={data.prevWeek.totalRevenue}
          />
        </div>

        <div className="h-40 -ml-2 -mr-2">
          {data.thisWeek.daily.filter((d) => d.revenue > 0).length < 3 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
              <TrendingUp className="w-12 h-12 text-fg-subtle" strokeWidth={1.25} />
              <p className="text-xs text-fg-muted max-w-xs">
                Данные накапливаются — график появится когда будет минимум 3 дня заказов
              </p>
            </div>
          ) : (
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

function ChangeIndicator({ changePct, prevRevenue }: { changePct: number | null; prevRevenue: number }) {
  if (changePct === null || prevRevenue === 0) {
    return (
      <div className="text-xs text-fg-subtle">
        Сравнение появится со следующей недели
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
