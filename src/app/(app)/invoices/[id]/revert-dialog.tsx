'use client'

import { useTransition } from 'react'
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
import { revertInvoice } from '../admin-actions'

interface Props {
  invoiceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RevertDialog({ invoiceId, open, onOpenChange }: Props) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleConfirm() {
    startTransition(async () => {
      const r = await revertInvoice(invoiceId)
      if (r.ok) {
        toast.success('Приёмка откачена')
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Откатить приёмку?</AlertDialogTitle>
          <AlertDialogDescription>
            Все цены ингредиентов вернутся к значениям до приёмки. Новые ингредиенты,
            созданные этой накладной, будут деактивированы. Действие необратимо без
            новой приёмки.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending}
            onClick={(e) => {
              e.preventDefault()
              handleConfirm()
            }}
          >
            {isPending ? 'Откатываем…' : 'Откатить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
