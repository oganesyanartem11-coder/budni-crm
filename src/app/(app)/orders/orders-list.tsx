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
import { toMskDateString } from '@/lib/utils/msk-window'
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

// «В работе» = заказ подтверждён и его дата доставки — сегодня.
// Для таких показываем пульсирующую точку (живой статус).
function isOrderLive(order: SerializedOrder): boolean {
  if (order.status !== 'CONFIRMED') return false
  // 7.43: МСК-календарный день строкой, без getTime() двух дат с setHours.
  return toMskDateString(new Date(order.deliveryDate)) === toMskDateString(new Date())
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
          aria-expanded={filtersOpen}
          className={cn(
            'px-3 py-2 sm:py-1.5 rounded-pill text-sm font-medium transition-colors flex items-center gap-1.5 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30',
            hasFilters
              ? 'bg-brand-green-light text-brand-green-deep'
              : 'bg-surface border border-border text-fg-muted hover:text-fg hover:bg-surface-2'
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
            className="px-3 py-2 sm:py-1.5 rounded-pill text-sm text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors flex items-center gap-1.5 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
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
                className="w-full pl-10 pr-3 py-2.5 sm:py-2 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors text-sm"
              />
            </div>

            <Select
              value={filters.clientId || '__all__'}
              onValueChange={(v) => onFilterChange({ clientId: v === '__all__' ? null : v })}
            >
              <SelectTrigger className="w-full !h-auto px-3 py-2.5 sm:py-2 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors text-sm data-placeholder:text-fg-muted">
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
              <SelectTrigger className="w-full !h-auto px-3 py-2.5 sm:py-2 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors text-sm data-placeholder:text-fg-muted">
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
            <SelectTrigger className="w-full md:w-auto !h-auto px-3 py-2.5 sm:py-2 rounded-xl bg-surface border-border focus-visible:border-brand-green focus-visible:ring-2 focus-visible:ring-brand-green/30 transition-colors text-sm data-placeholder:text-fg-muted">
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
        <div className="rounded-xl bg-surface border border-border p-12 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          <p>Заказов на эту дату не найдено</p>
          {hasFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-pill text-sm text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
            >
              <X className="w-3.5 h-3.5" />
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <div className={cn('transition-opacity', isPending && 'opacity-50 pointer-events-none')}>
          {/* lg+ : таблица */}
          <div className="hidden lg:block rounded-xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2/60 text-xs uppercase tracking-wider text-fg-muted">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Клиент / Точка</th>
                    <th className="text-left px-3 py-3 font-medium">Тип</th>
                    <th className="text-center px-3 py-3 font-medium">Порций</th>
                    <th className="text-right px-3 py-3 font-medium">Цена</th>
                    <th className="text-right px-3 py-3 font-medium">Сумма</th>
                    <th className="text-left px-3 py-3 font-medium">Статус</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {orders.map((order) => (
                    <tr
                      key={order.id}
                      className="group hover:bg-surface-2/40 transition-colors cursor-pointer align-middle"
                      onClick={(e) => {
                        // Не переходим если кликнули по интерактивному элементу внутри строки
                        const target = e.target as HTMLElement
                        if (target.closest('a, button, input')) return
                        router.push(`/orders/${order.id}`)
                      }}
                    >
                      <td className="px-4 py-3 align-middle">
                        <span className="flex items-center gap-2">
                          <Link
                            href={`/clients/${order.client.id}`}
                            className="hover:underline font-medium text-base break-words"
                          >
                            {order.client.name}
                          </Link>
                          {order.source === 'BORIS' && (
                            <span
                              className="shrink-0 text-xs px-2 py-0.5 rounded-pill bg-info-bg text-info-fg font-medium"
                              title="Создано Борей"
                            >
                              Боря
                            </span>
                          )}
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
                      <td className="px-3 py-3 text-fg-muted text-sm align-middle whitespace-nowrap">
                        {MEAL_TYPE_LABELS[order.mealType]}
                      </td>
                      <td className="px-3 py-3 text-center tabular-nums font-medium text-sm align-middle">
                        <PortionsCell order={order} />
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-fg-muted whitespace-nowrap align-middle">
                        {formatMoney(order.pricePerPortion)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold whitespace-nowrap text-sm align-middle">
                        {formatMoney(order.totalPrice)}
                      </td>
                      <td className="px-3 py-3 align-middle">
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

          {/* <lg : карточки */}
          <div className="lg:hidden space-y-3">
            {orders.map((order) => {
              const live = isOrderLive(order)
              return (
                <div
                  key={order.id}
                  role="link"
                  tabIndex={0}
                  onClick={(e) => {
                    const target = e.target as HTMLElement
                    if (target.closest('a, button, input')) return
                    router.push(`/orders/${order.id}`)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const target = e.target as HTMLElement
                      if (target.closest('a, button, input')) return
                      router.push(`/orders/${order.id}`)
                    }
                  }}
                  className="group rounded-xl border border-border bg-surface p-4 flex flex-col gap-3 cursor-pointer transition-colors hover:bg-surface-2/40 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
                  style={{ boxShadow: 'var(--shadow-card)' }}
                >
                  {/* header: имя клиента + статус */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 flex-wrap">
                        {live && (
                          <span
                            className={cn('inline-block w-2 h-2 rounded-full shrink-0 animate-pulse motion-reduce:animate-none', statusDotClass(order.status))}
                            aria-hidden="true"
                          />
                        )}
                        <Link
                          href={`/clients/${order.client.id}`}
                          className="hover:underline font-semibold text-base break-words"
                        >
                          {order.client.name}
                        </Link>
                        {order.source === 'BORIS' && (
                          <span
                            className="shrink-0 text-xs px-2 py-0.5 rounded-pill bg-info-bg text-info-fg font-medium"
                            title="Создано Борей"
                          >
                            Боря
                          </span>
                        )}
                        {!order.ourLegalEntityId && (
                          <span
                            title="УПД не может быть сформирован — не выбрано наше юрлицо отгрузки"
                            className="shrink-0 inline-flex items-center text-warning-fg"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
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
                  </div>

                  {/* тип питания */}
                  <div className="text-sm text-fg-muted">
                    {MEAL_TYPE_LABELS[order.mealType]}
                  </div>

                  {/* порции (инлайн-ввод) + сумма */}
                  <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs uppercase tracking-wider text-fg-subtle shrink-0">Порций</span>
                      {/* отступ справа под absolute-кнопку редактирования (44px) */}
                      <div className="tabular-nums font-medium text-base pr-12">
                        <PortionsCell order={order} />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-fg-muted tabular-nums">{formatMoney(order.pricePerPortion)} / порц.</div>
                      <div className="font-semibold tabular-nums text-base">{formatMoney(order.totalPrice)}</div>
                    </div>
                  </div>

                  {/* точка доставки */}
                  <div className="text-xs text-fg-muted truncate">
                    {order.location.name}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function AggregateCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl bg-surface border border-border p-3 lg:p-4 min-w-0"
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
          className="w-20 px-2 py-2.5 lg:py-1 rounded-lg bg-surface border border-brand-green text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-brand-green/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          aria-label="Сохранить"
          className="w-11 h-11 lg:w-7 lg:h-7 rounded-full bg-brand-green text-white flex items-center justify-center hover:bg-brand-green-deep disabled:opacity-50 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40"
        >
          <Check className="w-4 h-4 lg:w-3.5 lg:h-3.5" />
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
              className="hidden lg:inline-flex lg:absolute lg:right-full lg:mr-1 text-danger-fg"
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
              className="absolute left-full ml-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 w-11 h-11 lg:w-6 lg:h-6 rounded-full hover:bg-surface-2 flex items-center justify-center text-fg-subtle hover:text-fg transition-all [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/30"
            >
              <Edit2 className="w-3.5 h-3.5 lg:w-3 lg:h-3" />
            </button>
          )}
        </div>
        {wasEditedAfterLock && (
          <span className="lg:hidden text-[10px] leading-none text-danger-fg font-medium">
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
