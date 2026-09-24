'use client'

import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LeadLostReason } from '@prisma/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SalesField } from '@/components/sales/form-field'
import {
  CAPSULE_DANGER,
  CAPSULE_OUTLINE,
  DIALOG_CONTENT_CLASS,
  SELECT_TRIGGER_CLASS,
  TEXTAREA_CLASS,
} from '@/components/sales/styles'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { LOST_REASON_RU } from '@/lib/sales/labels'
import { changeLeadStatus } from '../actions'

const LOST_REASONS = Object.keys(LOST_REASON_RU) as LeadLostReason[]

interface LostDialogProps {
  leadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «❌ Отказ»: причина обязательна, комментарий — по желанию. */
export function LostDialog({ leadId, open, onOpenChange }: LostDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        {open && <LostDialogBody leadId={leadId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function LostDialogBody({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const ids = useId()
  const { run, isPending } = useSalesMutation()
  const [reason, setReason] = useState<LeadLostReason | ''>('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    if (!reason) {
      setError('Выбери причину отказа')
      return
    }
    run(
      () =>
        changeLeadStatus({
          leadId,
          status: 'LOST',
          lostReason: reason,
          lostComment: comment.trim() || null,
        }),
      { success: 'Заявка закрыта: отказ', onSuccess: onClose }
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-bold">Отказ</DialogTitle>
        <DialogDescription>Причина нужна, чтобы понимать, где воронка теряет клиентов.</DialogDescription>
      </DialogHeader>

      <SalesField label="Причина *" htmlFor={`${ids}-reason`} error={error}>
        <Select
          value={reason}
          onValueChange={(v) => {
            setReason(v as LeadLostReason)
            setError(null)
          }}
        >
          <SelectTrigger id={`${ids}-reason`} aria-invalid={!!error} className={SELECT_TRIGGER_CLASS}>
            <SelectValue placeholder="Выбери причину" />
          </SelectTrigger>
          <SelectContent>
            {LOST_REASONS.map((r) => (
              <SelectItem key={r} value={r} className="min-h-11">
                {LOST_REASON_RU[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SalesField>

      <SalesField label="Комментарий" htmlFor={`${ids}-comment`}>
        <textarea
          id={`${ids}-comment`}
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Что сказал клиент"
          className={TEXTAREA_CLASS}
        />
      </SalesField>

      <DialogFooter className="bg-surface-2">
        <button type="button" onClick={onClose} disabled={isPending} className={CAPSULE_OUTLINE}>
          Отмена
        </button>
        <button type="button" onClick={submit} disabled={isPending} className={CAPSULE_DANGER}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Отметить отказ
        </button>
      </DialogFooter>
    </>
  )
}
