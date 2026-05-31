import type { OrderStatus, DeliveryStatus } from '@prisma/client'
import { cn } from '@/lib/utils/cn'

type StatusVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

interface StatusBadgeProps {
  variant: StatusVariant
  children: React.ReactNode
  className?: string
}

const variantStyles: Record<StatusVariant, string> = {
  success: 'bg-success-bg text-success-fg',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
}

export function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-xs font-medium',
        variantStyles[variant],
        className
      )}
    >
      <span className={cn(
        'w-1.5 h-1.5 rounded-full',
        variant === 'success' && 'bg-success',
        variant === 'warning' && 'bg-warning',
        variant === 'danger' && 'bg-danger',
        variant === 'info' && 'bg-info',
        variant === 'neutral' && 'bg-neutral',
      )} />
      {children}
    </span>
  )
}

const ORDER_STATUS_MAP: Record<OrderStatus, { variant: StatusVariant; label: string }> = {
  DRAFT: { variant: 'neutral', label: 'Черновик' },
  PENDING_CONFIRMATION: { variant: 'warning', label: 'Ждём подтверждения' },
  CONFIRMED: { variant: 'success', label: 'Подтверждён' },
  LOCKED: { variant: 'info', label: 'Зафиксирован' },
  IN_PRODUCTION: { variant: 'info', label: 'На производстве' },
  OUT_FOR_DELIVERY: { variant: 'info', label: 'В доставке' },
  DELIVERED: { variant: 'success', label: 'Доставлен' },
  CANCELLED: { variant: 'neutral', label: 'Отменён' },
}

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const config = ORDER_STATUS_MAP[status]
  return (
    <StatusBadge variant={config.variant} className={className}>
      {config.label}
    </StatusBadge>
  )
}

const DELIVERY_STATUS_MAP: Record<DeliveryStatus, { variant: StatusVariant; label: string }> = {
  ASSIGNED: { variant: 'neutral', label: 'Назначен' },
  PICKED_UP: { variant: 'info', label: 'Забрал' },
  EN_ROUTE: { variant: 'info', label: 'В пути' },
  DELIVERED: { variant: 'success', label: 'Доставлено' },
  FAILED: { variant: 'danger', label: 'Не доставлено' },
}

export function DeliveryStatusBadge({ status, className }: { status: DeliveryStatus; className?: string }) {
  const config = DELIVERY_STATUS_MAP[status]
  return (
    <StatusBadge variant={config.variant} className={className}>
      {config.label}
    </StatusBadge>
  )
}

type DotBadgeVariant =
  | 'revenue'
  | 'margin'
  | 'orders'
  | 'amount'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral'

interface DotBadgeProps {
  count: number | string
  variant: DotBadgeVariant
  className?: string
}

const dotBadgeStyles: Record<DotBadgeVariant, string> = {
  revenue: 'bg-data-revenue-bg text-data-revenue-ink',
  margin: 'bg-data-margin-bg text-data-margin-ink',
  orders: 'bg-data-orders-bg text-data-orders-ink',
  amount: 'bg-data-amount-bg text-data-amount-ink',
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success-bg text-success-fg',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
}

export function DotBadge({ count, variant, className }: DotBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-pill min-w-[20px] h-[20px] px-1.5 text-[10px] font-bold tabular-nums',
        dotBadgeStyles[variant],
        className
      )}
    >
      {count}
    </span>
  )
}
