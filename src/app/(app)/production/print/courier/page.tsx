import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/current-user'
import { getAssemblyOrders } from '@/lib/db/queries/production'
import { formatDateLong, formatDeliveryWindow } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { PrintButton } from '../print-button'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function CourierPrintPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const targetDate = params.date ? new Date(params.date) : (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d
  })()
  targetDate.setHours(0, 0, 0, 0)

  const orders = await getAssemblyOrders(targetDate)
  const dateStr = params.date ?? targetDate.toISOString().slice(0, 10)

  // Группируем по точке (одна доставка = одна накладная)
  const byLocation = new Map<string, typeof orders>()
  for (const o of orders) {
    const key = `${o.clientName}|${o.locationName}|${o.locationAddress}`
    if (!byLocation.has(key)) byLocation.set(key, [])
    byLocation.get(key)!.push(o)
  }

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

      <div className="print-area max-w-3xl mx-auto">
        {orders.length === 0 ? (
          <div className="bg-surface border border-border rounded-2xl p-8 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
            На эту дату нет активных заказов.
          </div>
        ) : (
          Array.from(byLocation.entries()).map(([key, locationOrders]) => {
            const first = locationOrders[0]
            const totalPortions = locationOrders.reduce((s, o) => s + o.portions, 0)

            return (
              <div
                key={key}
                className="print-page bg-surface border border-border rounded-2xl p-8 mb-6"
                style={{ boxShadow: 'var(--shadow-card)' }}
              >
                <div className="border-b border-border pb-4 mb-5">
                  <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Накладная курьеру</p>
                  <h1 className="print-title text-2xl font-bold mb-1">{first.clientName}</h1>
                  <p className="text-base font-medium">{first.locationName}</p>
                  <p className="text-sm text-fg-muted mt-1">{first.locationAddress}</p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-5">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Дата доставки</p>
                    <p className="font-medium capitalize">{formatDateLong(targetDate)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Окно доставки</p>
                    <p className="font-medium">
                      {formatDeliveryWindow(first.deliveryWindowFrom, first.deliveryWindowTo) || 'Не указано'}
                    </p>
                  </div>
                  {first.clientContactPhone && (
                    <div>
                      <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Контакт</p>
                      <p className="font-medium">{first.clientContactPhone}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">Всего порций</p>
                    <p className="font-bold text-lg tabular-nums">{totalPortions}</p>
                  </div>
                </div>

                <table className="w-full text-sm mb-5">
                  <thead>
                    <tr>
                      <th className="text-left">Тип питания</th>
                      <th className="text-right">Порций</th>
                      <th className="text-left">Упаковка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locationOrders.map((o) => (
                      <tr key={o.orderId}>
                        <td className="font-medium">{MEAL_TYPE_LABELS[o.mealType]}</td>
                        <td className="text-right tabular-nums font-semibold">{o.portions}</td>
                        <td className="text-fg-muted">{o.packaging === 'INDIVIDUAL' ? 'Порционно' : 'Коробками'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {(first.tags.length > 0 || locationOrders.some((o) => o.notes)) && (
                  <div className="bg-warning-bg/30 border border-warning/20 rounded-xl p-3 text-sm">
                    <p className="text-xs uppercase tracking-wider text-warning-fg/80 font-medium mb-1.5">
                      Внимание
                    </p>
                    {first.tags.length > 0 && (
                      <p className="mb-1">
                        <strong>Особенности:</strong> {first.tags.join(', ')}
                      </p>
                    )}
                    {locationOrders.filter((o) => o.notes).map((o) => (
                      <p key={o.orderId} className="text-xs text-warning-fg/90">
                        <strong>{MEAL_TYPE_LABELS[o.mealType]}:</strong> {o.notes}
                      </p>
                    ))}
                  </div>
                )}

                <div className="mt-6 pt-4 border-t border-border grid grid-cols-2 gap-6 text-xs text-fg-muted">
                  <div>
                    <p className="mb-12">Передал (повар):</p>
                    <div className="border-t border-fg-subtle/40 pt-1">подпись / дата / время</div>
                  </div>
                  <div>
                    <p className="mb-12">Принял (получатель):</p>
                    <div className="border-t border-fg-subtle/40 pt-1">подпись / дата / время</div>
                  </div>
                </div>

                <div className="mt-4 text-xs text-fg-subtle text-right">
                  Сформировано: {new Date().toLocaleString('ru-RU')} · Будни CRM
                </div>
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
