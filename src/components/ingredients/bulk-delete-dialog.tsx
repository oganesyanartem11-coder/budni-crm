'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils/cn'
import { bulkDeleteIngredients } from '@/app/(app)/ingredients/actions'

export interface DeleteCandidate {
  id: string
  name: string
  dishIngredientCount: number
  invoiceLineCount: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: DeleteCandidate[]
  onDeleted?: () => void
}

export function BulkDeleteDialog({ open, onOpenChange, selected, onDeleted }: Props) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const undeletable = selected.filter(
    (s) => s.dishIngredientCount > 0 || s.invoiceLineCount > 0
  )
  const canDelete = undeletable.length === 0 && selected.length > 0

  function close() {
    if (pending) return
    onOpenChange(false)
  }

  function onConfirm() {
    if (!canDelete) return
    startTransition(async () => {
      const r = await bulkDeleteIngredients(selected.map((s) => s.id))
      if (r.ok) {
        toast.success(`Удалено ингредиентов: ${r.data.deletedCount}`)
        onOpenChange(false)
        onDeleted?.()
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
        else onOpenChange(true)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Удалить {selected.length} ингредиентов</DialogTitle>
          <DialogDescription>
            Ингредиенты со связями (DishIngredient/InvoiceLine) удалить нельзя — сначала освободите связи.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="max-h-72 overflow-y-auto border border-border rounded-xl">
            {selected.length === 0 ? (
              <p className="p-4 text-sm text-fg-muted text-center">Нет выбранных ингредиентов</p>
            ) : (
              <ul className="divide-y divide-border">
                {selected.map((ing) => {
                  const hasLinks = ing.dishIngredientCount > 0 || ing.invoiceLineCount > 0
                  return (
                    <li
                      key={ing.id}
                      className={cn(
                        'flex items-center justify-between gap-3 px-3 py-2.5 text-sm',
                        hasLinks ? 'bg-warning-bg/30' : ''
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={cn('truncate', hasLinks ? 'text-fg-muted' : 'text-fg font-medium')}>
                          {ing.name}
                        </div>
                        <div className="text-xs text-fg-muted mt-0.5">
                          {hasLinks ? (
                            <>
                              используется в {ing.dishIngredientCount} техкартах, {ing.invoiceLineCount} строках поставок
                            </>
                          ) : (
                            <span className="text-fg-subtle">нет связей — можно удалить</span>
                          )}
                        </div>
                      </div>
                      {hasLinks && (
                        <AlertTriangle className="w-4 h-4 text-warning-fg shrink-0" />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {undeletable.length > 0 && (
            <div className="rounded-xl bg-warning-bg border border-warning/30 p-3 text-xs text-warning-fg flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Освободите связи у {undeletable.length} ингредиент(ов) перед удалением. Удалить можно только полностью
                изолированные записи.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Отмена
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!canDelete || pending}
            variant="destructive"
          >
            {pending ? 'Удаляю…' : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
