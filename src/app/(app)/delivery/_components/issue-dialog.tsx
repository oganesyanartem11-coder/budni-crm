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
      <DialogContent className="[&>button]:min-h-11 [&>button]:min-w-11">
        <DialogHeader>
          <DialogTitle>Не удалось доставить</DialogTitle>
          <DialogDescription>
            Сообщите менеджеру причину. Заказ останется активным — менеджер свяжется с клиентом.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label htmlFor="delivery-issue-reason" className="text-sm font-medium">Причина</label>
            <Select value={reason} onValueChange={(v) => setReason(v as DeliveryIssueReason)}>
              <SelectTrigger
                id="delivery-issue-reason"
                className="min-h-11 w-full cursor-pointer rounded-xl border-border bg-bg px-3 py-2.5 transition-colors data-placeholder:text-fg-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 motion-reduce:transition-none"
              >
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
            <label htmlFor="delivery-issue-comment" className="text-sm font-medium">
              Комментарий <span className="text-fg-muted font-normal">(опционально, до 200 символов)</span>
            </label>
            <textarea
              id="delivery-issue-comment"
              rows={3}
              value={comment}
              maxLength={200}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: «закрыто, охранник просит звонок»"
              className="min-h-11 w-full resize-none rounded-xl border border-border bg-bg px-3 py-2 text-base transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 motion-reduce:transition-none"
            />
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="min-h-11 cursor-pointer rounded-pill border border-border-strong bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="min-h-11 cursor-pointer rounded-pill bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            {isPending ? 'Отправляем…' : 'Сообщить менеджеру'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
