'use client'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { ORDER_STATUS_LABELS } from '@/lib/constants/order'
import type { OrderStatus } from '@prisma/client'

const STATUSES_NEEDING_CONFIRM: OrderStatus[] = ['LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY']

export function requiresLockedEditConfirm(status: OrderStatus): boolean {
  return STATUSES_NEEDING_CONFIRM.includes(status)
}

interface Props {
  open: boolean
  status: OrderStatus
  onConfirm: () => void
  onCancel: () => void
}

export function LockedEditConfirmDialog({ open, status, onConfirm, onCancel }: Props) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Заказ уже в работе</AlertDialogTitle>
          <AlertDialogDescription>
            Этот заказ уже «{ORDER_STATUS_LABELS[status]}». Изменение порций после 16:00
            повлияет на производство и доставку. Кухня и курьер уже получили старые данные.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Всё равно изменить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
