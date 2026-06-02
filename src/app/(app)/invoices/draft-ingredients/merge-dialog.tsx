'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
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
import { mergeDraftIngredient } from './actions'
import type { DraftIngredient, ApprovedOption } from './draft-ingredients-list'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: DraftIngredient
  approvedOptions: ApprovedOption[]
}

const UNIT_LABELS: Record<string, string> = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
}

export function MergeDialog({ open, onOpenChange, draft, approvedOptions }: Props) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    return approvedOptions
      .filter((o) => {
        if (!q) return true
        return o.name.toLowerCase().includes(q)
      })
      .slice(0, 200)
  }, [approvedOptions, search])

  const target = useMemo(
    () => approvedOptions.find((o) => o.id === targetId) ?? null,
    [approvedOptions, targetId]
  )

  function reset() {
    setTargetId(null)
    setSearch('')
  }

  function close() {
    if (pending) return
    reset()
    onOpenChange(false)
  }

  function onConfirm() {
    if (!target) return
    startTransition(async () => {
      const r = await mergeDraftIngredient({
        draftId: draft.id,
        targetId: target.id,
      })
      if (r.ok) {
        toast.success(`«${draft.name}» объединён с «${target.name}»`)
        reset()
        onOpenChange(false)
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Объединить «{draft.name}»</DialogTitle>
          <DialogDescription>
            Выберите существующий ингредиент. DRAFT будет удалён, а его связи в
            поставках перейдут на выбранный.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти ингредиент…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface border border-border focus:border-fg/30 focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-y-auto border border-border rounded-xl">
            {candidates.length === 0 ? (
              <p className="p-4 text-sm text-fg-muted text-center">
                Нет подходящих ингредиентов.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {candidates.map((o) => {
                  const active = o.id === targetId
                  const unitMismatch = o.unit !== draft.unit
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => setTargetId(o.id)}
                        className={cn(
                          'w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between gap-2',
                          active
                            ? 'bg-fg/5 font-medium text-fg'
                            : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
                        )}
                      >
                        <span className="truncate">{o.name}</span>
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded-pill text-xs shrink-0 border',
                            unitMismatch
                              ? 'bg-warning/10 text-warning-fg border-warning/30'
                              : 'bg-bg text-fg-muted border-border'
                          )}
                          title={unitMismatch ? 'Единицы измерения различаются' : undefined}
                        >
                          {UNIT_LABELS[o.unit] ?? o.unit}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {target && (
            <div className="rounded-xl bg-warning/5 border border-warning/30 p-3 text-xs text-fg-muted space-y-1">
              <p>
                «{draft.name}» будет удалён, его brand-варианты добавятся в
                «{target.name}». Связи в поставках перенесутся.
              </p>
              {target.unit !== draft.unit && (
                <p className="font-medium text-warning-fg">
                  Внимание: единицы измерения различаются (
                  {UNIT_LABELS[draft.unit] ?? draft.unit} → {UNIT_LABELS[target.unit] ?? target.unit}).
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={onConfirm} disabled={!target || pending}>
            {pending ? 'Объединяю…' : 'Объединить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
