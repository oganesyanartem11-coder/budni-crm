'use client'

import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { ChartCard } from '@/components/charts/chart-card'
import { cn } from '@/lib/utils/cn'
import { formatMoneyRu } from '@/lib/digest/format'
import type { IngredientUnit } from '@prisma/client'
import type { GroupPriceTrendPoint } from '@/lib/db/queries/invoice-analytics'

type GroupKey = Extract<IngredientUnit, 'KG' | 'L' | 'PCS'>

interface Props {
  initial: {
    KG: GroupPriceTrendPoint[]
    L: GroupPriceTrendPoint[]
    PCS: GroupPriceTrendPoint[]
  }
}

const GROUP_LABELS: Record<GroupKey, string> = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
}

const GROUP_UNIT_SUFFIX: Record<GroupKey, string> = {
  KG: '/кг',
  L: '/л',
  PCS: '/шт',
}

/**
 * W4. Линия средней цены по неделям с переключателем группы (KG/L/PCS).
 * Группа выбирается на клиенте — данные для всех трёх групп предзагружены
 * сервером, переключение моментальное без обращения к серверу.
 */
export function GroupPriceTrendChart({ initial }: Props) {
  const [group, setGroup] = useState<GroupKey>('KG')

  const current = initial[group]
  const points = current.map((p) => ({
    label: formatWeekKey(p.week),
    value: p.avgPrice,
    count: p.count,
  }))

  const suffix = GROUP_UNIT_SUFFIX[group]

  return (
    <ChartCard
      title="Динамика средней цены по группам"
      subtitle="Усреднение по неделям, ₽ за единицу"
      height="md"
      action={
        <div className="inline-flex rounded-pill bg-fg/5 p-0.5">
          {(['KG', 'L', 'PCS'] as GroupKey[]).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              className={cn(
                'px-3 py-1 rounded-pill text-xs font-medium transition-colors',
                group === g
                  ? 'bg-accent text-accent-fg'
                  : 'text-fg-muted hover:text-fg'
              )}
            >
              {GROUP_LABELS[g]}
            </button>
          ))}
        </div>
      }
    >
      {points.length === 0 ? (
        <div className="flex items-center justify-center h-full text-sm text-fg-muted">
          Нет данных для группы «{GROUP_LABELS[group]}» за период
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
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'var(--color-fg-muted)', fontSize: 11 }}
              width={50}
              tickFormatter={(v) => Number(v).toLocaleString('ru-RU')}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: '12px',
                fontSize: '12px',
                boxShadow: 'var(--shadow-popover)',
              }}
              formatter={(value, name) => [
                `${formatMoneyRu(Number(value))} ${suffix}`,
                String(name ?? ''),
              ]}
              labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--color-accent)"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4 }}
              name={`Средняя цена ${suffix}`}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function formatWeekKey(key: string): string {
  const m = key.match(/W(\d{2})$/)
  if (!m) return key
  return `нед. ${parseInt(m[1], 10)}`
}
