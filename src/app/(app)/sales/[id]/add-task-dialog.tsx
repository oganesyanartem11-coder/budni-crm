'use client'

import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { SalesTaskType } from '@prisma/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CAPSULE_OUTLINE,
  CAPSULE_PRIMARY,
  DIALOG_CONTENT_CLASS,
  FIELD_LABEL_CLASS,
  TEXTAREA_CLASS,
} from '@/components/sales/styles'
import {
  DuePicker,
  TaskTypeChips,
  initialDueChoice,
  resolveDue,
  type DueChoice,
} from '@/components/sales/task-fields'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { TASK_TYPE_RU } from '@/lib/sales/labels'
import { quickSlots } from '@/lib/sales/time'
import { formatDueRelative } from '@/lib/utils/format'
import { createTask } from '../actions'

interface AddTaskDialogProps {
  leadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** «+ Задача»: тип, срок (быстрые слоты или своя дата/время МСК), заметка. */
export function AddTaskDialog({ leadId, open, onOpenChange }: AddTaskDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        {open && <AddTaskBody leadId={leadId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function AddTaskBody({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const ids = useId()
  const { run, isPending } = useSalesMutation()
  // Момент открытия (действие пользователя) — от него быстрые слоты.
  const [openedAt] = useState(() => new Date())
  const slots = useMemo(() => quickSlots(openedAt), [openedAt])
  const [type, setType] = useState<SalesTaskType>('CALL')
  const [due, setDue] = useState<DueChoice>(() => initialDueChoice(slots))
  const [note, setNote] = useState('')

  function submit() {
    const dueAt = resolveDue(due, slots)
    if (!dueAt) {
      toast.error('Укажи дату и время')
      return
    }
    run(() => createTask({ leadId, type, dueAt, note: note.trim() || null }), {
      success: (data) =>
        data.deduplicated
          ? 'Такая задача уже есть'
          : `Задача: ${TASK_TYPE_RU[type]} · ${formatDueRelative(dueAt, new Date())}`,
      onSuccess: onClose,
    })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-bold">Новая задача</DialogTitle>
        <DialogDescription>Что сделать и когда. Время — московское.</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <p className={FIELD_LABEL_CLASS}>Тип</p>
        <TaskTypeChips value={type} onChange={setType} disabled={isPending} />
      </div>

      <div className="space-y-2">
        <p className={FIELD_LABEL_CLASS}>Когда</p>
        <DuePicker slots={slots} now={openedAt} value={due} onChange={setDue} disabled={isPending} />
      </div>

      <div>
        <label htmlFor={`${ids}-note`} className={FIELD_LABEL_CLASS}>
          Заметка
        </label>
        <textarea
          id={`${ids}-note`}
          rows={2}
          value={note}
          disabled={isPending}
          onChange={(e) => setNote(e.target.value)}
          placeholder="О чём договорились, что уточнить"
          className={TEXTAREA_CLASS}
        />
      </div>

      <DialogFooter className="bg-surface-2">
        <button type="button" onClick={onClose} disabled={isPending} className={CAPSULE_OUTLINE}>
          Отмена
        </button>
        <button type="button" onClick={submit} disabled={isPending} className={CAPSULE_PRIMARY}>
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          Добавить задачу
        </button>
      </DialogFooter>
    </>
  )
}
