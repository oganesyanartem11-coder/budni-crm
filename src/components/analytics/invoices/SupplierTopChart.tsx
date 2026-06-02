'use client'

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { formatMoneyRu } from '@/lib/digest/format'
import type { SupplierTopRow } from '@/lib/db/queries/invoice-analytics'

interface Props {
  data: SupplierTopRow[]
}

/**
 * W1. Горизонтальный bar-chart Top-10 поставщиков по сумме принятых накладных
 * за период. DESC по total.
 */
export function SupplierTopChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-muted">
        За период нет принятых поставок
      </div>
    )
  }

  // recharts формат: ось X — суммы, ось Y — поставщики.
  const sorted = [...data].sort((a, b) => b.total - a.total)

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={sorted}
        layout="vertical"
        margin={{ top: 5, right: 12, bottom: 5, left: 12 }}
      >
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="supplierName"
          axisLine={false}
          tickLine={false}
          width={120}
          tick={{ fill: 'var(--color-fg-muted)', fontSize: 12 }}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '12px',
            fontSize: '12px',
            boxShadow: 'var(--shadow-popover)',
          }}
          formatter={(value, _name, item) => {
            const row = item?.payload as SupplierTopRow | undefined
            const count = row?.invoiceCount ?? 0
            return [
              `${formatMoneyRu(Number(value))} · ${count} ${pluralizeInvoices(count)}`,
              String(_name ?? ''),
            ]
          }}
          labelStyle={{ color: 'var(--color-fg)', fontWeight: 600 }}
          cursor={{ fill: 'var(--color-fg)', fillOpacity: 0.04 }}
        />
        <Bar dataKey="total" radius={[0, 6, 6, 0]}>
          {sorted.map((s) => (
            <Cell key={s.supplierName} fill="var(--color-accent)" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function pluralizeInvoices(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 14) return 'поставок'
  const last = n % 10
  if (last === 1) return 'поставка'
  if (last >= 2 && last <= 4) return 'поставки'
  return 'поставок'
}
