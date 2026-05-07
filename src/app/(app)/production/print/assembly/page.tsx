import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/current-user'
import { getAssemblyOrders } from '@/lib/db/queries/production'
import { formatDateLong, formatDeliveryWindow } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS, PACKAGING_LABELS } from '@/lib/constants/client'
import { PrintButton } from '../print-button'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function AssemblyPrintPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const params = await searchParams
  const targetDate = params.date ? new Date(params.date) : (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d
  })()
  targetDate.setHours(0, 0, 0, 0)

  const orders = await getAssemblyOrders(targetDate)
  const dateStr = params.date ?? targetDate.toISOString().slice(0, 10)

  const totalPortions = orders.reduce((s, o) => s + o.portions, 0)

  return (
    <>
      <div className="no-print mb-6 flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/production/print?date=${dateStr}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К меню печати
        </Link>
        <PrintButton />
      </div>

      <div className="print-area max-w-4xl mx-auto bg-surface border border-border rounded-2xl p-8" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="print-page">
          <h1 className="print-title text-2xl font-bold mb-1">Лист сборки заказов</h1>
          <p className="text-fg-muted text-sm capitalize mb-6">
            {formatDateLong(targetDate)} · {orders.length} заказов · {totalPortions} порций
          </p>

          {orders.length === 0 ? (
            <p className="text-fg-muted">На эту дату нет активных заказов.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Окно</th>
                  <th className="text-left">Клиент</th>
                  <th className="text-left">Точка</th>
                  <th className="text-left">Тип</th>
                  <th className="text-right">Порций</th>
                  <th className="text-left">Упаковка</th>
                  <th className="text-left">Теги</th>
                  <th className="text-left">Заметки</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId}>
                    <td className="whitespace-nowrap">
                      {formatDeliveryWindow(o.deliveryWindowFrom, o.deliveryWindowTo) || '—'}
                    </td>
                    <td className="font-medium">{o.clientName}</td>
                    <td className="text-fg-muted">{o.locationName}</td>
                    <td>{MEAL_TYPE_LABELS[o.mealType]}</td>
                    <td className="text-right tabular-nums font-semibold">{o.portions}</td>
                    <td>{PACKAGING_LABELS[o.packaging]}</td>
                    <td className="text-fg-muted">
                      {o.tags.length > 0 ? o.tags.join(', ') : '—'}
                    </td>
                    <td className="text-fg-muted">{o.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-8 pt-4 border-t border-border text-xs text-fg-subtle">
            Сформировано: {new Date().toLocaleString('ru-RU')} · Будни CRM
          </div>
        </div>
      </div>
    </>
  )
}
