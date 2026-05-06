'use client'

import { Search, X } from 'lucide-react'
import Link from 'next/link'
import { OrderStatusBadge } from '@/components/ui/status-badge'
import { formatMoney } from '@/lib/utils/format'
import { ORDER_STATUS_LABELS } from '@/lib/constants/order'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, ClientLocation, OrderStatus } from '@prisma/client'

type SerializedOrder = Omit<Order, 'pricePerPortion' | 'totalPrice'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
}

interface Props {
  orders: SerializedOrder[]
  clients: Array<{ id: string; name: string }>
  filters: {
    clientId: string
    mealType: string
    status: string
    search: string
  }
  onFilterChange: (patch: Record<string, string | null>) => void
  isPending: boolean
}

const ALL_STATUSES: OrderStatus[] = [
  'DRAFT',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
]

export function OrdersList({ orders, clients, filters, onFilterChange, isPending }: Props) {
  const hasFilters = filters.clientId || filters.mealType || filters.status || filters.search

  function clearAll() {
    onFilterChange({ clientId: null, mealType: null, status: null, search: null })
  }

  // Агрегаты по статусам для шапки
  const totalPortions = orders
    .filter((o) => o.status !== 'CANCELLED')
    .reduce((sum, o) => sum + o.portions, 0)
  const totalRevenue = orders
    .filter((o) => o.status !== 'CANCELLED')
    .reduce((sum, o) => sum + o.totalPrice, 0)

  return (
    <div className="space-y-4">
      {/* Фильтры */}
      <div className="rounded-2xl bg-surface border border-border p-4 space-y-3" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="relative md:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
            <input
              type="search"
              placeholder="Поиск по клиенту или точке"
              defaultValue={filters.search}
              onChange={(e) => onFilterChange({ search: e.target.value || null })}
              className="w-full pl-10 pr-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
            />
          </div>

          <select
            value={filters.clientId}
            onChange={(e) => onFilterChange({ clientId: e.target.value || null })}
            className="px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          >
            <option value="">Все клиенты</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <select
            value={filters.mealType}
            onChange={(e) => onFilterChange({ mealType: e.target.value || null })}
            className="px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          >
            <option value="">Все типы</option>
            <option value="BREAKFAST">{MEAL_TYPE_LABELS.BREAKFAST}</option>
            <option value="LUNCH">{MEAL_TYPE_LABELS.LUNCH}</option>
            <option value="DINNER">{MEAL_TYPE_LABELS.DINNER}</option>
          </select>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={filters.status}
            onChange={(e) => onFilterChange({ status: e.target.value || null })}
            className="px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          >
            <option value="">Все статусы</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>{ORDER_STATUS_LABELS[s]}</option>
            ))}
          </select>

          {hasFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="px-3 py-2 rounded-xl bg-bg hover:bg-border text-fg-muted hover:text-fg text-sm transition-colors flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" />
              Сбросить
            </button>
          )}
        </div>
      </div>

      {/* Агрегаты */}
      {orders.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <AggregateCard label="Заказов" value={orders.length.toString()} />
          <AggregateCard label="Порций" value={totalPortions.toString()} />
          <AggregateCard label="Сумма" value={formatMoney(totalRevenue)} />
        </div>
      )}

      {/* Таблица */}
      {orders.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <p>Заказов на эту дату не найдено</p>
          {hasFilters && <p className="text-sm mt-2">Попробуйте сбросить фильтры</p>}
        </div>
      ) : (
        <div className={cn('rounded-2xl bg-surface border border-border overflow-hidden transition-opacity', isPending && 'opacity-50')} style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/50 text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Клиент / Точка</th>
                  <th className="text-left px-3 py-3 font-medium">Тип</th>
                  <th className="text-right px-3 py-3 font-medium">Порций</th>
                  <th className="text-right px-3 py-3 font-medium hidden md:table-cell">Цена</th>
                  <th className="text-right px-3 py-3 font-medium">Сумма</th>
                  <th className="text-left px-3 py-3 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-bg/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/clients/${order.client.id}`} className="hover:underline font-medium">
                        {order.client.name}
                      </Link>
                      <div className="text-xs text-fg-muted">{order.location.name}</div>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {MEAL_TYPE_LABELS[order.mealType]}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium">
                      {order.portions}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg-muted hidden md:table-cell whitespace-nowrap">
                      {formatMoney(order.pricePerPortion)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold whitespace-nowrap">
                      {formatMoney(order.totalPrice)}
                    </td>
                    <td className="px-3 py-3">
                      <OrderStatusBadge status={order.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function AggregateCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-surface border border-border p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  )
}
