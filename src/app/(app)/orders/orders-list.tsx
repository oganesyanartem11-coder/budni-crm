'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, Edit2, Check, AlertTriangle, Filter, ChevronDown, ChevronUp } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { OrderStatusBadge } from '@/components/ui/status-badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LockedEditConfirmDialog, requiresLockedEditConfirm } from './_components/locked-edit-confirm'
import { editOrderPortions } from './actions'
import { formatMoney } from '@/lib/utils/format'
import { ORDER_STATUS_LABELS, ORDER_STATUS_VARIANT, portionsEditedToast } from '@/lib/constants/order'
import { showActionError } from '@/lib/ui/optimistic-lock-toast'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, ClientLocation, OrderStatus } from '@prisma/client'

type SerializedOrder = Omit<Order, 'pricePerPortion' | 'totalPrice' | 'vatRate'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
  delivery: { issueReportedAt: Date | string | null } | null
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

// Цветовая точка статуса для мобильной таблицы (где колонка «Статус» скрыта).
// Цвет берётся из ORDER_STATUS_VARIANT и маппится в bg-{token} класс.
const VARIANT_DOT_BG: Record<'success' | 'warning' | 'danger' | 'info' | 'neutral', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
}

function statusDotClass(status: OrderStatus): string {
  return VARIANT_DOT_BG[ORDER_STATUS_VARIANT[status]]
}

export function OrdersList({ orders, clients, filters, onFilterChange, isPending }: Props) {
  const router = useRouter()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeFilterCount =
    (filters.clientId ? 1 : 0) +
    (filters.mealType ? 1 : 0) +
    (filters.status ? 1 : 0) +
    (filters.search.trim() ? 1 : 0)
  const hasFilters = activeFilterCount > 0

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
      {/* Фильтры — свёрнуты по умолчанию */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className={cn(
            'px-3 py-1.5 rounded-pill text-sm font-medium transition-colors flex items-center gap-1.5',
            hasFilters
              ? 'bg-accent text-accent-fg'
              : 'bg-surface border border-border text-fg-muted hover:text-fg hover:bg-bg'
          )}
        >
          <Filter className="w-3.5 h-3.5" />
          Фильтры
          {hasFilters && <span className="tabular-nums">· {activeFilterCount}</span>}
          {filtersOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="px-3 py-1.5 rounded-pill text-sm text-fg-muted hover:text-fg hover:bg-bg transition-colors flex items-center gap-1.5"
          >
            <X className="w-3.5 h-3.5" />
            Сбросить
          </button>
        )}
      </div>

      {filtersOpen && (
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

            <Select
              value={filters.clientId || '__all__'}
              onValueChange={(v) => onFilterChange({ clientId: v === '__all__' ? null : v })}
            >
              <SelectTrigger className="w-full !h-auto px-3 py-2 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors text-sm data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Все клиенты</SelectItem>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.mealType || '__all__'}
              onValueChange={(v) => onFilterChange({ mealType: v === '__all__' ? null : v })}
            >
              <SelectTrigger className="w-full !h-auto px-3 py-2 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors text-sm data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Все типы</SelectItem>
                <SelectItem value="BREAKFAST">{MEAL_TYPE_LABELS.BREAKFAST}</SelectItem>
                <SelectItem value="LUNCH">{MEAL_TYPE_LABELS.LUNCH}</SelectItem>
                <SelectItem value="DINNER">{MEAL_TYPE_LABELS.DINNER}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Select
            value={filters.status || '__all__'}
            onValueChange={(v) => onFilterChange({ status: v === '__all__' ? null : v })}
          >
            <SelectTrigger className="w-full md:w-auto !h-auto px-3 py-2 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors text-sm data-placeholder:text-fg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Все статусы</SelectItem>
              {ALL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{ORDER_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Агрегаты */}
      {orders.length > 0 && (
        <div className="grid grid-cols-3 gap-2 lg:gap-3">
          <AggregateCard label="Заказов" value={orders.length.toString()} />
          <AggregateCard label="Порций" value={totalPortions.toString()} />
          <AggregateCard label="Сумма" value={formatMoney(totalRevenue)} />
        </div>
      )}

      {/* Таблица */}
      {orders.length === 0 ? (
        <div className="rounded-2xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <p>Заказов на эту дату не найдено</p>
          {hasFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill text-sm text-fg-muted hover:text-fg hover:bg-bg transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <div className={cn('rounded-2xl bg-surface border border-border overflow-hidden transition-opacity', isPending && 'opacity-50')} style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/50 text-[10px] lg:text-xs uppercase tracking-wider text-fg-muted">
                <tr>
                  <th className="text-left px-2 py-2 lg:px-4 lg:py-3 font-medium">Клиент / Точка</th>
                  <th className="text-left px-2 py-2 lg:px-3 lg:py-3 font-medium">Тип</th>
                  <th className="text-center px-2 py-2 lg:px-3 lg:py-3 font-medium">Порций</th>
                  <th className="text-right px-3 py-3 font-medium hidden md:table-cell">Цена</th>
                  <th className="text-right px-2 py-2 lg:px-3 lg:py-3 font-medium">Сумма</th>
                  <th className="text-left px-2 py-2 lg:px-3 lg:py-3 font-medium hidden md:table-cell">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="group hover:bg-bg/30 transition-colors cursor-pointer align-middle"
                    onClick={(e) => {
                      // Не переходим если кликнули по интерактивному элементу внутри строки
                      const target = e.target as HTMLElement
                      if (target.closest('a, button, input')) return
                      router.push(`/orders/${order.id}`)
                    }}
                  >
                    <td className="px-2 py-3 lg:px-4 align-middle">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            'md:hidden inline-block w-2 h-2 rounded-full shrink-0',
                            statusDotClass(order.status)
                          )}
                          title={ORDER_STATUS_LABELS[order.status]}
                          aria-label={ORDER_STATUS_LABELS[order.status]}
                        />
                        <Link
                          href={`/clients/${order.client.id}`}
                          className="hover:underline font-medium text-sm lg:text-base break-words"
                        >
                          {order.client.name}
                        </Link>
                        {!order.ourLegalEntityId && (
                          <span
                            title="УПД не может быть сформирован — не выбрано наше юрлицо отгрузки"
                            className="shrink-0 inline-flex items-center text-warning-fg"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                      </span>
                      <div className="text-xs text-fg-muted truncate">{order.location.name}</div>
                    </td>
                    <td className="px-2 py-3 lg:px-3 text-fg-muted text-xs lg:text-sm align-middle whitespace-nowrap">
                      {MEAL_TYPE_LABELS[order.mealType]}
                    </td>
                    <td className="px-2 py-3 lg:px-3 text-center tabular-nums font-medium text-xs lg:text-sm align-middle">
                      <PortionsCell order={order} />
                    </td>
                    <td className="px-2 py-3 lg:px-3 text-right tabular-nums text-fg-muted hidden md:table-cell whitespace-nowrap align-middle">
                      {formatMoney(order.pricePerPortion)}
                    </td>
                    <td className="px-2 py-3 lg:px-3 text-right tabular-nums font-semibold whitespace-nowrap text-xs lg:text-sm align-middle">
                      {formatMoney(order.totalPrice)}
                    </td>
                    <td className="px-2 py-3 lg:px-3 align-middle hidden md:table-cell">
                      <div className="flex items-center gap-1.5">
                        <OrderStatusBadge status={order.status} />
                        {order.delivery?.issueReportedAt && (
                          <AlertTriangle
                            className="w-3.5 h-3.5 text-danger-fg shrink-0"
                            aria-label="Курьер сообщил о проблеме"
                          >
                            <title>Курьер сообщил о проблеме</title>
                          </AlertTriangle>
                        )}
                      </div>
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
    <div
      className="rounded-2xl bg-surface border border-border p-3 lg:p-4 min-w-0"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <p className="text-[10px] uppercase tracking-wider text-fg-muted lg:text-xs lg:normal-case lg:tracking-normal truncate">
        {label}
      </p>
      <p className="text-lg font-bold tabular-nums mt-1 whitespace-nowrap lg:text-2xl">
        {value}
      </p>
    </div>
  )
}

function PortionsCell({ order }: { order: SerializedOrder }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(order.portions))
  const [isPending, startTransition] = useTransition()
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Заказ можно редактировать только в активных статусах (не CANCELLED/DELIVERED/PENDING/DRAFT)
  const editable = ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'].includes(order.status)
  const wasEditedAfterLock = !!order.editedAfterLockAt

  function doSubmit(num: number) {
    startTransition(async () => {
      const result = await editOrderPortions({
        orderId: order.id,
        portions: num,
        expectedUpdatedAt: new Date(order.updatedAt).toISOString(),
      })
      if (result.ok) {
        const opts = result.data.editedAfterLock ? { icon: '⚠️' } : undefined
        toast.success(portionsEditedToast(num, result.data.editedAfterLock), opts)
        setEditing(false)
      } else {
        const wasLock = showActionError(result.error, () => router.refresh())
        if (!wasLock) setValue(String(order.portions))
        else setEditing(false) // на конфликте закрываем edit — после refresh откроется снова
      }
    })
  }

  function handleSubmit() {
    const num = parseInt(value, 10)
    if (isNaN(num) || num < 0) {
      toast.error('Введите корректное число')
      return
    }
    if (num === order.portions) {
      setEditing(false)
      return
    }
    if (requiresLockedEditConfirm(order.status)) {
      setConfirmOpen(true)
      return
    }
    doSubmit(num)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 justify-center">
        <input
          type="number"
          min="0"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            } else if (e.key === 'Escape') {
              setEditing(false)
              setValue(String(order.portions))
            }
          }}
          onBlur={() => {
            if (parseInt(value, 10) === order.portions) {
              setEditing(false)
            }
          }}
          disabled={isPending}
          className="w-20 px-2 py-1 rounded-lg bg-bg border border-accent text-sm text-right tabular-nums focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          aria-label="Сохранить"
          className="w-7 h-7 rounded-full bg-accent text-accent-fg flex items-center justify-center hover:opacity-90 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  // Цифра в центре, иконки (warning + edit) absolute по краям — чтобы
  // их наличие/отсутствие не сдвигало позицию числа от строки к строке.
  // На мобиле добавляем подпись «правка» под цифрой, потому что title
  // на тач-устройствах не работает и иконка одна непонятна.
  return (
    <>
      <div className="flex flex-col items-center gap-0.5">
        <div className="relative flex items-center justify-center">
          {wasEditedAfterLock && (
            <span
              title="Правлено после 16:00 — кухню и курьера может задеть"
              className="absolute right-full mr-1 text-danger-fg"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
            </span>
          )}
          <span>{order.portions}</span>
          {editable && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Редактировать порции"
              className="absolute left-full ml-1 opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full hover:bg-bg flex items-center justify-center text-fg-subtle hover:text-fg transition-all"
            >
              <Edit2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {wasEditedAfterLock && (
          <span className="md:hidden text-[10px] leading-none text-danger-fg font-medium">
            правка
          </span>
        )}
      </div>
      <LockedEditConfirmDialog
        open={confirmOpen}
        status={order.status}
        onConfirm={() => {
          setConfirmOpen(false)
          doSubmit(parseInt(value, 10))
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}
