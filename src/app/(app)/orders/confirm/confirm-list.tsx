'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, Clock, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { confirmDynamicOrder } from '../actions'
import { formatMoney, formatDateLong } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { cn } from '@/lib/utils/cn'
import type { Order, Client, ClientLocation } from '@prisma/client'

type SerializedPendingOrder = Omit<Order, 'pricePerPortion' | 'totalPrice'> & {
  pricePerPortion: number
  totalPrice: number
  client: Pick<Client, 'id' | 'name'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address'>
  sourceConfig: { id: string; fixedPortions: number | null } | null
}

interface Props {
  orders: SerializedPendingOrder[]
}

const CUTOFF_HOUR = 16

function getCutoffStatus(deliveryDate: Date): {
  isPastCutoff: boolean
  hoursLeft: number | null
  minutesLeft: number | null
} {
  // Cut-off — 16:00 ДНЯ ПЕРЕД доставкой (т.е. если deliveryDate = завтра, cutoff сегодня в 16:00)
  const cutoff = new Date(deliveryDate)
  cutoff.setDate(cutoff.getDate() - 1)
  cutoff.setHours(CUTOFF_HOUR, 0, 0, 0)

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
      <div className="rounded-2xl bg-surface border border-border p-12 text-center" style={{ boxShadow: 'var(--shadow-card)' }}>
        <div className="w-16 h-16 mx-auto rounded-full bg-success-bg flex items-center justify-center mb-4">
          <Check className="w-8 h-8 text-success-fg" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Все заказы подтверждены</h2>
        <p className="text-fg-muted">Никаких ожидающих DYNAMIC-заказов на ближайшие дни.</p>
      </div>
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
            <div className="rounded-2xl bg-surface border border-border overflow-hidden" style={{ boxShadow: 'var(--shadow-card)' }}>
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
      const result = await confirmDynamicOrder({ orderId: order.id, portions: portionsNum })
      if (result.ok) {
        if (result.data.status === 'CANCELLED') {
          toast.success('Заказ отклонён клиентом — кухне не пойдёт')
        } else {
          toast.success(`Подтверждено: ${portionsNum} порций`)
        }
        onChanged()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleDecline() {
    setPortions('0')
    startTransition(async () => {
      const result = await confirmDynamicOrder({ orderId: order.id, portions: 0 })
      if (result.ok) {
        toast.success('Заказ отклонён клиентом — кухне не пойдёт')
        onChanged()
      } else {
        toast.error(result.error)
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

      <div className="flex items-center gap-2">
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
          className="w-24 px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm tabular-nums text-right"
        />
        <div className="text-sm font-medium tabular-nums w-24 text-right text-fg-muted">
          {totalPrice > 0 ? formatMoney(totalPrice) : '—'}
        </div>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isPending || portionsNum <= 0}
          className="px-3 py-2 rounded-pill bg-success text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5"
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
          className="w-9 h-9 rounded-full hover:bg-danger-bg/40 text-fg-muted hover:text-danger-fg transition-colors flex items-center justify-center"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
