'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { reportDeliveryIssue } from '../actions'
import {
  DELIVERY_ISSUE_REASONS,
  DELIVERY_ISSUE_REASON_LABELS,
  type DeliveryIssueReason,
} from '@/lib/constants/delivery'

interface Props {
  open: boolean
  orderIds: string[]
  // Если уже была отправка — предзаполняем форму, чтобы курьер мог поправить.
  initialReason?: DeliveryIssueReason | null
  initialComment?: string | null
  onClose: () => void
  onReported: () => void
}

export function IssueDialog({ open, orderIds, initialReason, initialComment, onClose, onReported }: Props) {
  const [reason, setReason] = useState<DeliveryIssueReason>(initialReason ?? 'CLIENT_UNAVAILABLE')
  const [comment, setComment] = useState(initialComment ?? '')
  const [isPending, startTransition] = useTransition()

  // Сбрасываем форму на каждое открытие — иначе после успешной отправки одной
  // карточки на следующей увидим прошлые значения.
  useEffect(() => {
    if (open) {
      setReason(initialReason ?? 'CLIENT_UNAVAILABLE')
      setComment(initialComment ?? '')
    }
  }, [open, initialReason, initialComment])

  function handleSubmit() {
    startTransition(async () => {
      const result = await reportDeliveryIssue({
        orderIds,
        reason,
        comment: comment.trim() || null,
      })
      if (result.ok) {
        toast.success('Менеджеру сообщили. Ожидайте звонка.')
        onReported()
        onClose()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Не удалось доставить</DialogTitle>
          <DialogDescription>
            Сообщите менеджеру причину. Заказ останется активным — менеджер свяжется с клиентом.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Причина</label>
            <Select value={reason} onValueChange={(v) => setReason(v as DeliveryIssueReason)}>
              <SelectTrigger className="w-full !h-auto px-3 py-2.5 rounded-xl bg-bg border-border focus-visible:border-accent focus-visible:ring-0 transition-colors data-placeholder:text-fg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_ISSUE_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>{DELIVERY_ISSUE_REASON_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Комментарий <span className="text-fg-subtle font-normal">(опционально, до 200 символов)</span>
            </label>
            <textarea
              rows={3}
              value={comment}
              maxLength={200}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: «закрыто, охранник просит звонок»"
              className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors resize-none text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="px-5 py-2.5 rounded-pill bg-danger text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isPending ? 'Отправляем…' : 'Сообщить менеджеру'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
