import type { InvoiceStatus } from '@prisma/client'
import { cn } from '@/lib/utils/cn'

// Единый chip-индикатор статуса Invoice — используется в шапке детальной
// страницы и в карточках списка /invoices (DRY).
// Цвета — проектные семантические токены (warning/success/danger) из globals.css.
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  PROCESSING: 'Обрабатывается',
  AWAITING_ACCEPT: 'Ожидает принятия',
  ACCEPTED: 'Принята',
  REJECTED: 'Отклонена',
  REVERTED: 'Откачена',
  FAILED: 'Ошибка',
}

const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  PROCESSING: 'bg-fg/5 text-fg-muted border-border',
  AWAITING_ACCEPT: 'bg-warning/10 text-warning-fg border-warning/30',
  ACCEPTED: 'bg-success/10 text-success-fg border-success/30',
  REJECTED: 'bg-fg/5 text-fg-muted border-border',
  REVERTED: 'bg-fg/5 text-fg-muted border-border',
  FAILED: 'bg-danger/10 text-danger-fg border-danger/30',
}

export function InvoiceStatusChip({ status, className }: { status: InvoiceStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        INVOICE_STATUS_STYLES[status],
        className,
      )}
    >
      {INVOICE_STATUS_LABELS[status]}
    </span>
  )
}
