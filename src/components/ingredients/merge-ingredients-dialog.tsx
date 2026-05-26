'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
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
import { mergeIngredients, getMergePreview } from '@/app/(app)/ingredients/actions'
import type { IngredientUnit } from '@prisma/client'

const UNIT_LABELS: Record<IngredientUnit, string> = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
}

export interface MergeCandidate {
  id: string
  name: string
  unit: IngredientUnit
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: MergeCandidate[]
  onMerged?: () => void
}

interface Preview {
  dishIngredientsToMigrate: number
  dishIngredientsToDelete: number
  invoiceLinesToMigrate: number
  priceHistoryToDelete: number
}

export function MergeIngredientsDialog({ open, onOpenChange, selected, onMerged }: Props) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const router = useRouter()

  // Сброс при закрытии/смене selected
  useEffect(() => {
    if (!open) {
      setTargetId(null)
      setPreview(null)
      return
    }
    // По умолчанию выбираем первый ингредиент как target
    if (selected.length > 0 && !targetId) {
      setTargetId(selected[0].id)
    }
  }, [open, selected, targetId])

  const target = useMemo(
    () => selected.find((s) => s.id === targetId) ?? null,
    [selected, targetId]
  )
  const sources = useMemo(
    () => selected.filter((s) => s.id !== targetId),
    [selected, targetId]
  )

  // Загружаем preview когда выбран target
  useEffect(() => {
    if (!open || !target || sources.length === 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    getMergePreview(
      target.id,
      sources.map((s) => s.id)
    )
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setPreview(r.data)
        } else {
          setPreview(null)
        }
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, target, sources])

  // Unit mismatch detection
  const unitMismatch = useMemo(() => {
    if (!target) return false
    return sources.some((s) => s.unit !== target.unit)
  }, [target, sources])

  function close() {
    if (pending) return
    onOpenChange(false)
  }

  function onConfirm() {
    if (!target || sources.length === 0) return
    startTransition(async () => {
      const r = await mergeIngredients(
        target.id,
        sources.map((s) => s.id)
      )
      if (r.ok) {
        toast.success(
          `Объединено: ${r.data.mergedCount + 1} → 1 («${target.name}»)`
        )
        onOpenChange(false)
        onMerged?.()
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
          <DialogTitle>Объединить {selected.length} ингредиентов</DialogTitle>
          <DialogDescription>
            Выберите целевой ингредиент. Остальные будут удалены, их связи перейдут на целевой.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="max-h-64 overflow-y-auto border border-border rounded-xl">
            {selected.length === 0 ? (
              <p className="p-4 text-sm text-fg-muted text-center">Нет выбранных ингредиентов</p>
            ) : (
              <ul className="divide-y divide-border">
                {selected.map((ing) => {
                  const isTarget = ing.id === targetId
                  return (
                    <li key={ing.id}>
                      <label
                        className={cn(
                          'flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors',
                          isTarget ? 'bg-fg/5 font-medium text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
                        )}
                      >
                        <input
                          type="radio"
                          name="merge-target"
                          checked={isTarget}
                          onChange={() => setTargetId(ing.id)}
                          className="accent-accent"
                        />
                        <span className="flex-1 truncate">{ing.name}</span>
                        <span className="px-2 py-0.5 rounded-pill text-xs shrink-0 border bg-bg text-fg-muted border-border">
                          {UNIT_LABELS[ing.unit]}
                        </span>
                        {isTarget && (
                          <span className="px-2 py-0.5 rounded-pill text-xs shrink-0 bg-accent text-accent-fg">
                            целевой
                          </span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {unitMismatch && (
            <div className="rounded-xl bg-warning-bg border border-warning/30 p-3 text-xs text-warning-fg flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Внимание: единицы измерения у выбранных ингредиентов различаются. Это может привести к некорректным
                расчётам в техкартах. Проверьте brutto/netto после объединения.
              </span>
            </div>
          )}

          {target && sources.length > 0 && (
            <div className="rounded-xl bg-bg/50 border border-border p-3 text-xs text-fg-muted space-y-1">
              {previewLoading ? (
                <p>Считаю что переедет…</p>
              ) : preview ? (
                <>
                  <p>
                    Будет перенесено: <span className="text-fg font-medium">{preview.dishIngredientsToMigrate}</span> записей
                    DishIngredient
                    {preview.dishIngredientsToDelete > 0 && (
                      <>
                        {' '}(из них <span className="text-fg font-medium">{preview.dishIngredientsToDelete}</span> конфликтов —
                        будут удалены у источников)
                      </>
                    )}
                    , <span className="text-fg font-medium">{preview.invoiceLinesToMigrate}</span> строк InvoiceLine.
                  </p>
                  <p>
                    История цен источников ({preview.priceHistoryToDelete} записей) будет удалена.
                  </p>
                </>
              ) : (
                <p>
                  Будет объединено {selected.length} → 1 ингредиент. История цен источников будет удалена.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Отмена
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!target || sources.length === 0 || pending}
            className="bg-accent text-accent-fg hover:opacity-90"
          >
            {pending ? 'Объединяю…' : 'Объединить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
