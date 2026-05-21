'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

type Point = { label: string; value: number }

type RevenueLineChartProps = {
  data: Point[]
  formatValue?: (v: number) => string // для tooltip; по умолчанию — ru-RU number
  emptyMessage?: string // если data.length === 0
}

export function RevenueLineChart({
  data,
  formatValue = (v) => v.toLocaleString('ru-RU'),
  emptyMessage = 'Нет данных за период',
}: RevenueLineChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-muted">
        {emptyMessage}
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
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
          formatter={(value) => [formatValue(Number(value)), '']}
          labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-accent)"
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
