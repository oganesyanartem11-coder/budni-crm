'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Calendar, MapPin, Package, ClipboardList, User, Clock,
  AlertTriangle, X, CalendarClock, History, ExternalLink, Tag,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { PhoneLink } from '@/components/ui/phone-link'
import { OrderStatusBadge } from '@/components/ui/status-badge'
import { LockedEditConfirmDialog, requiresLockedEditConfirm } from '../_components/locked-edit-confirm'
import { cancelOrder, rescheduleOrder, editOrderPortions, confirmDynamicOrder } from '../actions'
import { clearDeliveryIssue } from '../../delivery/actions'
import { DELIVERY_ISSUE_REASON_LABELS, type DeliveryIssueReason } from '@/lib/constants/delivery'
import { formatMoney, formatDateLong, formatDeliveryWindow, formatDateShort, formatPortions } from '@/lib/utils/format'
import { MEAL_TYPE_LABELS, PACKAGING_LABELS, ORDER_TYPE_SHORT } from '@/lib/constants/client'
import { portionsEditedToast } from '@/lib/constants/order'
import { cn } from '@/lib/utils/cn'
import type { Client, ClientLocation, User as PrismaUser, MealType, OrderStatus, PackagingType, OrderSource, Prisma } from '@prisma/client'

interface OrderData {
  id: string
  status: OrderStatus
  source: OrderSource
  mealType: MealType
  deliveryDate: Date | string
  portions: number
  pricePerPortion: number
  totalPrice: number
  packaging: PackagingType
  notes: string | null
  createdAt: Date | string
  confirmedAt: Date | string | null
  lockedAt: Date | string | null
  editedAfterLockAt: Date | string | null
  client: Pick<Client, 'id' | 'name' | 'contactName' | 'contactPhone'>
  location: Pick<ClientLocation, 'id' | 'name' | 'address' | 'packaging' | 'tags' | 'deliveryWindowFrom' | 'deliveryWindowTo'>
  sourceConfig: { id: string; orderType: string; scheduleType: string; fixedPortions: number | null } | null
  createdBy: Pick<PrismaUser, 'id' | 'name' | 'role'> | null
  delivery: {
    id: string
    status: string
    deliveredAt: Date | string | null
    courierName: string | null
    issueReportedAt: Date | string | null
    issueReason: string | null
    issueComment: string | null
    issueReportedById: string | null
  } | null
}

interface HistoryEntry {
  id: string
  action: string
  payload: Prisma.JsonValue
  createdAt: Date | string
  user: { id: string; name: string; role: string } | null
}

interface Props {
  order: OrderData
  history: HistoryEntry[]
}

const ACTION_LABELS: Record<string, string> = {
  ORDER_CREATED: 'Создан',
  ORDER_CONFIRMED: 'Подтверждён',
  ORDER_DECLINED: 'Отклонён клиентом',
  ORDER_PORTIONS_EDITED: 'Изменены порции',
  ORDER_CANCELLED: 'Отменён',
  ORDER_RESCHEDULED: 'Перенесён',
  ORDERS_LOCKED: 'Зафиксирован автоматически',
  FIXED_ORDERS_GENERATED: 'Сгенерирован автоматически',
}

export function OrderDetail({ order, history }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [editingPortions, setEditingPortions] = useState(false)
  const [portionsValue, setPortionsValue] = useState(String(order.portions))
  const [editConfirmOpen, setEditConfirmOpen] = useState(false)

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [newDate, setNewDate] = useState(
    new Date(order.deliveryDate).toISOString().slice(0, 10)
  )

  const wasEditedAfterLock = !!order.editedAfterLockAt
  const issueReportedAt = order.delivery?.issueReportedAt ?? null
  const issueReason = order.delivery?.issueReason ?? null
  const issueComment = order.delivery?.issueComment ?? null
  const deliveryId = order.delivery?.id ?? null

  function handleClearIssue() {
    if (!deliveryId) return
    startTransition(async () => {
      const result = await clearDeliveryIssue({ deliveryId })
      if (result.ok) {
        toast.success('Метка снята')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }
  const isEditable = ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'].includes(order.status)
  const isPending_ = order.status === 'PENDING_CONFIRMATION'
  const isCancellable = !['CANCELLED', 'DELIVERED'].includes(order.status)
  const isReschedulable = !['CANCELLED', 'DELIVERED'].includes(order.status)

  function doEditPortions(num: number) {
    startTransition(async () => {
      const result = await editOrderPortions({ orderId: order.id, portions: num })
      if (result.ok) {
        const opts = result.data.editedAfterLock ? { icon: '⚠️' } : undefined
        toast.success(portionsEditedToast(num, result.data.editedAfterLock), opts)
        setEditingPortions(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleEditPortions() {
    const num = parseInt(portionsValue, 10)
    if (isNaN(num) || num < 0) {
      toast.error('Введите корректное число')
      return
    }
    if (num === order.portions) {
      setEditingPortions(false)
      return
    }
    if (requiresLockedEditConfirm(order.status)) {
      setEditConfirmOpen(true)
      return
    }
    doEditPortions(num)
  }

  function handleConfirm() {
    const num = parseInt(portionsValue, 10)
    if (isNaN(num) || num < 0) {
      toast.error('Введите корректное число')
      return
    }
    startTransition(async () => {
      const result = await confirmDynamicOrder({ orderId: order.id, portions: num })
      if (result.ok) {
        toast.success(result.data.status === 'CANCELLED' ? 'Заказ отклонён' : `Подтверждено: ${formatPortions(num)}`)
        setEditingPortions(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelOrder({
        orderId: order.id,
        reason: cancelReason.trim() || null,
      })
      if (result.ok) {
        toast.success('Заказ отменён')
        setCancelOpen(false)
        setCancelReason('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleReschedule() {
    startTransition(async () => {
      const result = await rescheduleOrder({
        orderId: order.id,
        newDate,
      })
      if (result.ok) {
        toast.success('Заказ перенесён')
        setRescheduleOpen(false)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
      {/* Левая колонка — детали + история */}
      <div className="space-y-5">
        {/* Статус-блок */}
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <OrderStatusBadge status={order.status} />
              {wasEditedAfterLock && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-pill bg-danger-bg text-danger-fg text-xs font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Правлено после 16:00
                </div>
              )}
            </div>
            <div className="text-xs text-fg-muted">
              ID: <span className="font-mono">{order.id.slice(0, 8)}</span>
            </div>
          </div>

          {issueReportedAt && (
            <div className="mt-4 rounded-xl bg-danger-bg/40 border border-danger/30 p-3 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-danger-fg shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-danger-fg">
                  🚨 Курьер сообщил о проблеме: {issueReason ? DELIVERY_ISSUE_REASON_LABELS[issueReason as DeliveryIssueReason] : '—'}
                </p>
                {issueComment && (
                  <p className="text-sm text-danger-fg/90 mt-1 italic">«{issueComment}»</p>
                )}
                <p className="text-xs text-danger-fg/70 mt-1">
                  {formatDateShort(new Date(issueReportedAt))} · статус заказа не изменён, нужно решение менеджера
                </p>
              </div>
              <button
                type="button"
                onClick={handleClearIssue}
                disabled={isPending}
                className="shrink-0 text-xs text-danger-fg hover:text-fg underline underline-offset-2 disabled:opacity-50"
              >
                Снять метку
              </button>
            </div>
          )}

          {order.notes && (
            <div className="mt-4 rounded-xl bg-warning-bg/30 border border-warning/20 p-3">
              <p className="text-xs uppercase tracking-wider text-warning-fg/80 font-medium mb-1">Заметки клиента</p>
              <p className="text-sm whitespace-pre-line">{order.notes}</p>
            </div>
          )}
        </div>

        {/* Параметры */}
        <div className="rounded-2xl bg-surface border border-border p-5 space-y-4" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-base font-semibold">Параметры</h2>

          <Row icon={User} label="Клиент">
            <Link href={`/clients/${order.client.id}`} className="font-medium hover:underline inline-flex items-center gap-1">
              {order.client.name}
              <ExternalLink className="w-3 h-3 text-fg-subtle" />
            </Link>
            {order.client.contactName && (
              <span className="text-fg-muted ml-2">· {order.client.contactName}</span>
            )}
            {order.client.contactPhone && (
              <span className="text-fg-muted ml-2">
                · <PhoneLink phone={order.client.contactPhone} className="text-fg-muted hover:text-fg" />
              </span>
            )}
          </Row>

          <Row icon={MapPin} label="Точка">
            <span className="font-medium">{order.location.name}</span>
            <div className="text-xs text-fg-muted mt-0.5">{order.location.address}</div>
          </Row>

          <Row icon={Calendar} label="Доставка">
            <span className="font-medium capitalize">{formatDateLong(new Date(order.deliveryDate))}</span>
            {(order.location.deliveryWindowFrom || order.location.deliveryWindowTo) && (
              <span className="text-fg-muted ml-2">
                · окно {formatDeliveryWindow(order.location.deliveryWindowFrom, order.location.deliveryWindowTo)}
              </span>
            )}
          </Row>

          <Row icon={ClipboardList} label="Тип / Порции">
            <span className="font-medium">{MEAL_TYPE_LABELS[order.mealType]}</span>
            <span className="text-fg-muted ml-2">·</span>
            {editingPortions ? (
              <span className="inline-flex items-center gap-1.5 ml-2">
                <input
                  type="number"
                  min="0"
                  autoFocus
                  value={portionsValue}
                  onChange={(e) => setPortionsValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      isPending_ ? handleConfirm() : handleEditPortions()
                    } else if (e.key === 'Escape') {
                      setEditingPortions(false)
                      setPortionsValue(String(order.portions))
                    }
                  }}
                  disabled={isPending}
                  className="w-24 px-2 py-1 rounded-lg bg-bg border border-accent text-sm tabular-nums focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={isPending_ ? handleConfirm : handleEditPortions}
                  disabled={isPending}
                  className="px-2 py-1 rounded-lg bg-accent text-accent-fg text-xs hover:opacity-90 disabled:opacity-50"
                >
                  OK
                </button>
              </span>
            ) : (
              <>
                <span className="font-medium ml-2 tabular-nums">{order.portions}</span>
                {(isEditable || isPending_) && (
                  <button
                    type="button"
                    onClick={() => setEditingPortions(true)}
                    className="ml-2 text-xs text-fg-subtle hover:text-fg underline"
                  >
                    {isPending_ ? 'подтвердить' : 'изменить'}
                  </button>
                )}
              </>
            )}
          </Row>

          <Row icon={Package} label="Упаковка">
            <span className="font-medium">{PACKAGING_LABELS[order.packaging]}</span>
            {order.location.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {order.location.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-warning-bg text-warning-fg text-xs font-medium">
                    <Tag className="w-3 h-3" /> {t}
                  </span>
                ))}
              </div>
            )}
          </Row>

          <Row icon={Clock} label="Источник">
            <SourceLabel source={order.source} />
            {order.sourceConfig && (
              <span className="text-xs text-fg-muted ml-2">
                ({ORDER_TYPE_SHORT[order.sourceConfig.orderType as 'FIXED' | 'DYNAMIC']})
              </span>
            )}
            {order.createdBy && (
              <span className="text-xs text-fg-muted ml-2">
                · {order.createdBy.name}
              </span>
            )}
          </Row>
        </div>

        {/* История */}
        <div className="rounded-2xl bg-surface border border-border p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
          <div className="flex items-center gap-2 mb-4">
            <History className="w-4 h-4 text-fg-muted" />
            <h2 className="text-base font-semibold">История изменений</h2>
            <span className="text-xs text-fg-subtle">({history.length})</span>
          </div>

          {history.length === 0 ? (
            <p className="text-sm text-fg-muted">История пуста</p>
          ) : (
            <ul className="space-y-3">
              {history.map((h) => (
                <li key={h.id} className="flex items-start gap-3 text-sm">
                  <div className="w-2 h-2 rounded-full bg-fg-subtle mt-1.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</span>
                      <span className="text-xs text-fg-muted">
                        {formatDateShort(new Date(h.createdAt))} · {new Date(h.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {h.user && (
                        <span className="text-xs text-fg-muted">
                          · {h.user.name}
                        </span>
                      )}
                    </div>
                    <PayloadHint action={h.action} payload={h.payload} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Правая колонка — сумма + действия */}
      <div className="space-y-4">
        <div className="rounded-2xl bg-surface border border-border p-5 sticky top-4" style={{ boxShadow: 'var(--shadow-card)' }}>
          <h2 className="text-base font-semibold mb-4">Сумма</h2>

          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-fg-muted">Порций</dt>
              <dd className="tabular-nums">{order.portions}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-fg-muted">Цена</dt>
              <dd className="tabular-nums">{formatMoney(order.pricePerPortion)}</dd>
            </div>
          </dl>

          <div className="border-t border-border my-4" />

          <div className="flex items-baseline justify-between">
            <span className="text-sm text-fg-muted">Итого</span>
            <span className="text-2xl font-bold tabular-nums">{formatMoney(order.totalPrice)}</span>
          </div>

          {/* Действия */}
          <div className="mt-5 space-y-2">
            {isReschedulable && (
              <button
                type="button"
                onClick={() => setRescheduleOpen(true)}
                disabled={isPending}
                className="w-full px-4 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <CalendarClock className="w-4 h-4" />
                Перенести на другую дату
              </button>
            )}
            {isCancellable && (
              <button
                type="button"
                onClick={() => setCancelOpen(true)}
                disabled={isPending}
                className="w-full px-4 py-2.5 rounded-pill bg-danger-bg/40 hover:bg-danger-bg text-danger-fg font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
                Отменить заказ
              </button>
            )}
            {!isCancellable && !isReschedulable && (
              <p className="text-xs text-fg-subtle text-center py-2">
                Заказ в финальном статусе. Действия недоступны.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Модалка отмены */}
      {cancelOpen && (
        <Modal title="Отменить заказ" onClose={() => setCancelOpen(false)}>
          <p className="text-sm text-fg-muted">
            Вы собираетесь отменить заказ для <strong>{order.client.name}</strong> на{' '}
            <strong>{formatDateLong(new Date(order.deliveryDate))}</strong>. Это действие записывается в историю и не может быть отменено.
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Причина (необязательно)</label>
            <textarea
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Например: клиент перенёс совещание"
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors text-sm resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCancelOpen(false)}
              disabled={isPending}
              className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
            >
              Закрыть
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isPending}
              className="px-5 py-2.5 rounded-pill bg-danger text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending ? 'Отменяем…' : 'Подтвердить отмену'}
            </button>
          </div>
        </Modal>
      )}

      {/* Модалка переноса */}
      {rescheduleOpen && (
        <Modal title="Перенести на другую дату" onClose={() => setRescheduleOpen(false)}>
          <p className="text-sm text-fg-muted">
            Текущая дата: <strong>{formatDateLong(new Date(order.deliveryDate))}</strong>
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Новая дата</label>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors"
            />
            <p className="text-xs text-fg-subtle">
              Если на эту дату уже есть заказ для этой точки и типа — перенос не сработает.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setRescheduleOpen(false)}
              disabled={isPending}
              className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={handleReschedule}
              disabled={isPending}
              className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isPending ? 'Переносим…' : 'Перенести'}
            </button>
          </div>
        </Modal>
      )}

      <LockedEditConfirmDialog
        open={editConfirmOpen}
        status={order.status}
        onConfirm={() => {
          setEditConfirmOpen(false)
          doEditPortions(parseInt(portionsValue, 10))
        }}
        onCancel={() => setEditConfirmOpen(false)}
      />
    </div>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-full bg-bg flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-fg-muted" strokeWidth={1.75} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs uppercase tracking-wider text-fg-subtle mb-0.5">{label}</div>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  )
}

function SourceLabel({ source }: { source: OrderSource }) {
  const labels: Record<OrderSource, string> = {
    MANUAL: 'Создан вручную',
    FIXED_AUTO: 'Авто-генерация (постоянное число)',
    RECURRING_AUTO: 'Авто-генерация (по запросу)',
    MESSENGER: 'Из мессенджера',
    BOT: 'Из MAX-бота',
  }
  return <span className="font-medium">{labels[source]}</span>
}

function PayloadHint({ action, payload }: { action: string; payload: Prisma.JsonValue }) {
  // Сужаем JsonValue до object: только plain-object имеет смысл для наших action-ов
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>

  if (action === 'ORDER_PORTIONS_EDITED') {
    const old = data.oldPortions
    const next = data.newPortions
    const afterCutoff = Boolean(data.afterCutoff ?? data.afterLock)
    return (
      <p className="text-xs text-fg-muted mt-0.5">
        {String(old)} → {String(next)}
        {afterCutoff ? ' · после 16:00' : ''}
      </p>
    )
  }
  if (action === 'ORDER_RESCHEDULED') {
    const oldDate = typeof data.oldDate === 'string' ? data.oldDate : undefined
    const newDate = typeof data.newDate === 'string' ? data.newDate : undefined
    if (oldDate && newDate) {
      return (
        <p className="text-xs text-fg-muted mt-0.5">
          {formatDateShort(new Date(oldDate))} → {formatDateShort(new Date(newDate))}
        </p>
      )
    }
  }
  if (action === 'ORDER_CANCELLED') {
    const reason = typeof data.reason === 'string' ? data.reason : null
    if (reason) {
      return <p className="text-xs text-fg-muted mt-0.5">Причина: {reason}</p>
    }
  }
  if (action === 'ORDER_CONFIRMED') {
    const portions = data.portions
    if (portions !== undefined) {
      return <p className="text-xs text-fg-muted mt-0.5">Подтверждено порций: {String(portions)}</p>
    }
  }
  return null
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-fg/30 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-surface border border-border p-5 space-y-4" style={{ boxShadow: 'var(--shadow-popover)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-8 h-8 rounded-full hover:bg-bg flex items-center justify-center text-fg-muted hover:text-fg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
