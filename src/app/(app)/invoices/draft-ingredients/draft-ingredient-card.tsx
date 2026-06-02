'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Trash2, ArrowLeftRight, FileText } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { formatDateLong } from '@/lib/utils/format'
import { formatMoneyRu } from '@/lib/digest/format'
import { approveDraftIngredient, deleteDraftIngredient } from './actions'
import { MergeDialog } from './merge-dialog'
import type { DraftIngredient, ApprovedOption } from './draft-ingredients-list'

interface BrandVariant {
  rawName?: string
  lastSeenPrice?: number
  lastSeenDate?: string
}

interface Props {
  draft: DraftIngredient
  approvedOptions: ApprovedOption[]
}

const UNIT_LABELS: Record<string, string> = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
}

export function DraftIngredientCard({ draft, approvedOptions }: Props) {
  const [mergeOpen, setMergeOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const variants = Array.isArray(draft.brandVariants)
    ? (draft.brandVariants as BrandVariant[]).filter((v) => v && v.rawName)
    : []
  const lastLine = draft.invoiceLines[0] ?? null

  function handleApprove() {
    startTransition(async () => {
      const r = await approveDraftIngredient(draft.id)
      if (r.ok) {
        toast.success(`Ингредиент «${draft.name}» утверждён`)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  function handleDelete() {
    startTransition(async () => {
      const r = await deleteDraftIngredient(draft.id)
      if (r.ok) {
        toast.success(`Ингредиент «${draft.name}» удалён`)
        setDeleteOpen(false)
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div
      className="bg-surface border border-border rounded-2xl p-4 space-y-3"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-fg truncate">{draft.name}</h3>
            <span className="px-2 py-0.5 rounded-pill text-xs bg-bg text-fg-muted border border-border shrink-0">
              {UNIT_LABELS[draft.unit] ?? draft.unit}
            </span>
          </div>
          <p className="text-sm text-fg-muted mt-0.5 tabular-nums">
            {formatMoneyRu(draft.pricePerUnit)} / {UNIT_LABELS[draft.unit] ?? draft.unit}
          </p>
        </div>
      </div>

      {variants.length > 0 && (
        <p className="text-xs text-fg-muted">
          Был как:{' '}
          {variants
            .map((v) => v.rawName)
            .filter(Boolean)
            .join(', ')}
        </p>
      )}

      {lastLine && (
        <Link
          href={`/invoices/${lastLine.invoice.id}`}
          className="flex items-center gap-2 text-xs text-fg-muted hover:text-fg transition-colors"
        >
          <FileText className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            Из поставки {lastLine.invoice.supplierName} от{' '}
            {formatDateLong(lastLine.invoice.invoiceDate)}
          </span>
        </Link>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant="default"
          onClick={handleApprove}
          disabled={pending}
        >
          <Check className="w-3.5 h-3.5" />
          Утвердить
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMergeOpen(true)}
          disabled={pending}
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
          Объединить с…
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={pending}
        >
          <Trash2 className="w-3.5 h-3.5" />
          Удалить
        </Button>
      </div>

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        draft={draft}
        approvedOptions={approvedOptions}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить ингредиент «{draft.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              История поставок останется (позиции отметятся как пропущенные), но
              ингредиент будет удалён. Действие необратимо.
              {draft._count.dishIngredients > 0 && (
                <>
                  {' '}
                  Внимание: ингредиент используется в {draft._count.dishIngredients}{' '}
                  техкарт(ах) — удаление будет отклонено.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
            >
              {pending ? 'Удаляем…' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
