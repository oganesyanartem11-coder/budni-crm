'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { rejectInvoice } from '../admin-actions'

interface Props {
  invoiceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MAX_REASON_LENGTH = 500

export function RejectDialog({ invoiceId, open, onOpenChange }: Props) {
  const [reason, setReason] = useState('')
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit() {
    const trimmed = reason.trim()
    if (!trimmed) {
      toast.error('Укажите причину отклонения')
      return
    }
    if (trimmed.length > MAX_REASON_LENGTH) {
      toast.error(`Причина слишком длинная (макс. ${MAX_REASON_LENGTH})`)
      return
    }
    startTransition(async () => {
      const r = await rejectInvoice(invoiceId, trimmed)
      if (r.ok) {
        toast.success('Поставка отклонена')
        onOpenChange(false)
        setReason('')
        router.push('/invoices')
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Отклонить поставку?</AlertDialogTitle>
          <AlertDialogDescription>
            Цены не будут применены. Укажите причину — она сохранится в журнале.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Например: фото размыто, не получилось распознать"
            rows={3}
            maxLength={MAX_REASON_LENGTH}
            disabled={isPending}
            className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm resize-none"
          />
          <p className="text-xs text-fg-subtle text-right">
            {reason.length} / {MAX_REASON_LENGTH}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending || !reason.trim()}
            onClick={(e) => {
              e.preventDefault()
              handleSubmit()
            }}
          >
            {isPending ? 'Отклоняем…' : 'Отклонить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
