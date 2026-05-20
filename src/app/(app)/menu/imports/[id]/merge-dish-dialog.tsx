'use client'

import { useState, useMemo, useTransition } from 'react'
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
import { mergeDishes } from '../actions'
import { cn } from '@/lib/utils/cn'
import type { SerializedDish } from './dishes-list-view'

interface Props {
  open: boolean
  onClose: () => void
  source: SerializedDish | null // блюдо, которое будет удалено
  allDishes: SerializedDish[] // выбор target (без source)
}

export function MergeDishDialog({ open, onClose, source, allDishes }: Props) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const candidates = useMemo(() => {
    if (!source) return []
    const q = search.trim().toLowerCase()
    return allDishes
      .filter((d) => d.id !== source.id)
      .filter((d) => {
        if (!q) return true
        const haystack = `${d.correctedName ?? d.name} ${d.originalName ?? ''}`.toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) =>
        (a.correctedName ?? a.name).localeCompare(b.correctedName ?? b.name, 'ru')
      )
  }, [allDishes, source, search])

  const target = useMemo(
    () => allDishes.find((d) => d.id === targetId) ?? null,
    [allDishes, targetId]
  )

  function reset() {
    setTargetId(null)
    setSearch('')
  }

  function close() {
    if (pending) return
    reset()
    onClose()
  }

  function onConfirm() {
    if (!source || !target) return
    startTransition(async () => {
      const r = await mergeDishes({ keepId: target.id, removeId: source.id })
      if (r.ok) {
        toast.success(
          r.data.menuDayDishesMoved > 0
            ? `Слито: ${r.data.menuDayDishesMoved} связей в меню перенесены`
            : 'Блюдо удалено (связей в меню не было)'
        )
        reset()
        onClose()
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
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Слить блюдо «{source?.correctedName ?? source?.name ?? '—'}»
          </DialogTitle>
          <DialogDescription>
            Выбранное блюдо будет удалено, его связи в меню перейдут на целевое.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти целевое блюдо…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl bg-surface border border-border focus:border-fg/30 focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-y-auto border border-border rounded-xl">
            {candidates.length === 0 ? (
              <p className="p-4 text-sm text-fg-muted text-center">Нет подходящих блюд.</p>
            ) : (
              <ul className="divide-y divide-border">
                {candidates.map((d) => {
                  const active = d.id === targetId
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => setTargetId(d.id)}
                        className={cn(
                          'w-full text-left px-3 py-2 text-sm transition-colors',
                          active ? 'bg-fg/5 font-medium text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
                        )}
                      >
                        {d.correctedName ?? d.name}
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
                Связи в меню «{source?.correctedName ?? source?.name}» (
                {source?.ingredients.length ?? 0} ингр.) будут перенесены на
                «{target.correctedName ?? target.name}» ({target.ingredients.length} ингр.).
              </p>
              <p className="font-medium text-warning-fg">
                Состав блюда «{source?.correctedName ?? source?.name}» будет удалён. Действие необратимо.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={!target || pending}
          >
            {pending ? 'Сливаю…' : 'Слить блюда'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
