import { MENU_STATUS_LABELS } from '@/lib/constants/menu-status'
import { cn } from '@/lib/utils/cn'
import type { MenuStatus } from '@prisma/client'

// Единый chip-индикатор статуса MenuImport — используется в шапке детальной
// страницы и в карточках списка /menu/imports (DRY).
// Цвета — проектные семантические токены (warning/success/fg) из globals.css.
const STATUS_STYLES: Record<MenuStatus, string> = {
  DRAFT: 'bg-fg/5 text-fg-muted border-border',
  PENDING_APPROVAL: 'bg-warning/10 text-warning-fg border-warning/30',
  APPROVED: 'bg-success/10 text-success-fg border-success/30',
  ARCHIVED: 'bg-fg/10 text-fg-muted border-border',
}

export function StatusChip({ status, className }: { status: MenuStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
        className
      )}
    >
      {MENU_STATUS_LABELS[status]}
    </span>
  )
}
