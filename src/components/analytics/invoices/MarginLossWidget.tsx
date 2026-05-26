'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { formatMoneyRu } from '@/lib/digest/format'
import type { MarginLossResult } from '@/lib/db/queries/invoice-analytics'

interface Props {
  data: MarginLossResult
}

/**
 * W3. «Скрытая потеря маржи»: сколько руб. потенциально потеряно из-за того,
 * что один и тот же ингредиент за период покупался по более высокой цене,
 * чем минимально возможная. График — по неделям.
 */
export function MarginLossWidget({ data }: Props) {
  const points = data.byWeek.map((p) => ({
    label: formatWeekKey(p.week),
    value: p.loss,
  }))

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div>
        <p className="text-xs uppercase tracking-wider text-fg-muted font-medium">
          Потенциальная экономия
        </p>
        <p className="text-3xl font-bold text-warning-fg tabular-nums tracking-tight mt-1">
          {formatMoneyRu(data.totalLoss)}
        </p>
        <p className="text-xs text-fg-subtle mt-0.5">
          Если бы покупали всё по минимальной цене за период
        </p>
      </div>
      <div className="flex-1 min-h-0">
        {points.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-fg-muted">
            Недостаточно данных
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <XAxis
                dataKey="label"
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
                formatter={(value, name) => [formatMoneyRu(Number(value)), String(name ?? '')]}
                labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-warning, var(--color-accent))"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

/**
 * '2026-W21' → 'нед. 21' (короткий лейбл для оси).
 */
function formatWeekKey(key: string): string {
  const m = key.match(/W(\d{2})$/)
  if (!m) return key
  return `нед. ${parseInt(m[1], 10)}`
}
