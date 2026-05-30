'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { toast } from 'sonner'
import { confirmDynamicOrder } from '../actions'
import { getCutoffMoment } from '@/lib/orders/cutoff'
import { formatMoney, formatDateLong, formatPortions } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { showActionError } from '@/lib/ui/optimistic-lock-toast'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, ClientLocation } from '@prisma/client'

type SerializedPendingOrder = Omit<Order, 'pricePerPortion' | 'totalPrice' | 'vatRate'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
  sourceConfig: { id: string; fixedPortions: number | null } | null
}

interface Props {
  orders: SerializedPendingOrder[]
}

function getCutoffStatus(deliveryDate: Date): {
  isPastCutoff: boolean
  hoursLeft: number | null
  minutesLeft: number | null
} {
  // Cut-off привязан к зоне Europe/Moscow (см. lib/orders/cutoff.ts)
  const cutoff = getCutoffMoment(deliveryDate)
  const now = new Date()
  const diff = cutoff.getTime() - now.getTime()

  if (diff < 0) {
    return { isPastCutoff: true, hoursLeft: null, minutesLeft: null }
  }

  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  return { isPastCutoff: false, hoursLeft: hours, minutesLeft: minutes }
}

export function ConfirmList({ orders }: Props) {
  const router = useRouter()

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Все заказы подтверждены"
        description="Нет заказов, ожидающих подтверждения, на ближайшие дни."
      />
    )
  }

  // Группировка по дате доставки
  const groupedByDate = new Map<string, SerializedPendingOrder[]>()
  for (const o of orders) {
    const dateKey = new Date(o.deliveryDate).toISOString().slice(0, 10)
    if (!groupedByDate.has(dateKey)) groupedByDate.set(dateKey, [])
    groupedByDate.get(dateKey)!.push(o)
  }

  const sortedDates = Array.from(groupedByDate.keys()).sort()

  return (
    <div className="space-y-6">
      {sortedDates.map((dateKey) => {
        const dateOrders = groupedByDate.get(dateKey)!
        const dateObj = new Date(dateOrders[0].deliveryDate)
        const cutoff = getCutoffStatus(dateObj)

        return (
          <div key={dateKey} className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-lg font-semibold capitalize">
                {formatDateLong(dateObj)}
              </h2>
              <CutoffBadge cutoff={cutoff} />
            </div>
            <div className="rounded-xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
              {dateOrders.map((o, idx) => (
                <div key={o.id} className={cn(idx > 0 && 'border-t border-border')}>
                  <ConfirmRow order={o} pastCutoff={cutoff.isPastCutoff} onChanged={() => router.refresh()} />
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CutoffBadge({ cutoff }: { cutoff: ReturnType<typeof getCutoffStatus> }) {
  if (cutoff.isPastCutoff) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1 rounded-pill bg-danger-bg text-danger-fg text-xs font-medium">
        <AlertTriangle className="w-3.5 h-3.5" />
        Cut-off прошёл
      </div>
    )
  }
  const totalMin = (cutoff.hoursLeft ?? 0) * 60 + (cutoff.minutesLeft ?? 0)
  const tone = totalMin < 60 ? 'danger' : totalMin < 180 ? 'warning' : 'info'
  const toneClasses = {
    danger: 'bg-danger-bg text-danger-fg',
    warning: 'bg-warning-bg text-warning-fg',
    info: 'bg-info-bg text-info-fg',
  }
  return (
    <div className={cn('flex items-center gap-1.5 px-3 py-1 rounded-pill text-xs font-medium', toneClasses[tone])}>
      <Clock className="w-3.5 h-3.5" />
      Осталось {cutoff.hoursLeft}ч {cutoff.minutesLeft}мин
    </div>
  )
}

function ConfirmRow({
  order,
  pastCutoff,
  onChanged,
}: {
  order: SerializedPendingOrder
  pastCutoff: boolean
  onChanged: () => void
}) {
  const [portions, setPortions] = useState<string>(
    order.sourceConfig?.fixedPortions?.toString() ?? ''
  )
  const [isPending, startTransition] = useTransition()

  const portionsNum = parseInt(portions, 10) || 0
  const totalPrice = portionsNum * order.pricePerPortion

  function handleConfirm() {
    if (portionsNum < 0) {
      toast.error('Порций не может быть отрицательным')
      return
    }
    startTransition(async () => {
      const result = await confirmDynamicOrder({
        orderId: order.id,
        portions: portionsNum,
        expectedUpdatedAt: new Date(order.updatedAt).toISOString(),
      })
      if (result.ok) {
        if (result.data.status === 'CANCELLED') {
          toast.success('Заказ отклонён клиентом — кухне не пойдёт')
        } else {
          toast.success(`Подтверждено: ${formatPortions(portionsNum)}`)
        }
        onChanged()
      } else {
        showActionError(result.error, onChanged)
      }
    })
  }

  function handleDecline() {
    setPortions('0')
    startTransition(async () => {
      const result = await confirmDynamicOrder({
        orderId: order.id,
        portions: 0,
        expectedUpdatedAt: new Date(order.updatedAt).toISOString(),
      })
      if (result.ok) {
        toast.success('Заказ отклонён клиентом — кухне не пойдёт')
        onChanged()
      } else {
        showActionError(result.error, onChanged)
      }
    })
  }

  return (
    <div className={cn(
      'p-4 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center transition-colors',
      pastCutoff && 'bg-danger-bg/10'
    )}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold truncate">{order.client.name}</span>
          <span className="text-sm text-fg-muted">·</span>
          <span className="text-sm text-fg-muted truncate">{order.location.name}</span>
        </div>
        <div className="flex items-baseline gap-3 text-xs text-fg-muted mt-0.5">
          <span>{MEAL_TYPE_LABELS[order.mealType]}</span>
          <span>{formatMoney(order.pricePerPortion)} / порция</span>
          {order.sourceConfig?.fixedPortions && (
            <span>обычно {order.sourceConfig.fixedPortions}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap md:flex-nowrap justify-end">
        <input
          type="number"
          min="0"
          inputMode="numeric"
          value={portions}
          onChange={(e) => setPortions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleConfirm()
            }
          }}
          placeholder="порций"
          disabled={isPending}
          className="w-24 min-h-[44px] px-3 py-2 rounded-xl bg-surface border border-border focus:outline-none focus:ring-2 focus:ring-brand-green/30 focus:border-brand-green transition-colors text-sm tabular-nums text-right"
        />
        <div className="text-sm font-medium tabular-nums w-24 text-right text-fg-muted">
          {totalPrice > 0 ? formatMoney(totalPrice) : '—'}
        </div>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isPending || portionsNum <= 0}
          className="px-4 min-h-[44px] rounded-xl bg-brand-green text-white text-sm font-medium hover:bg-brand-green-deep transition-colors disabled:opacity-50 flex items-center gap-1.5 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40"
        >
          <Check className="w-4 h-4" />
          OK
        </button>
        <button
          type="button"
          onClick={handleDecline}
          disabled={isPending}
          aria-label="Клиент отказался"
          title="Клиент отказался — заказ не пойдёт на кухню"
          className="w-11 h-11 rounded-full hover:bg-danger-bg/40 text-fg-muted hover:text-danger-fg transition-colors flex items-center justify-center shrink-0 [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
