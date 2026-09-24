'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlarmClock, Check, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  CAPSULE_DANGER,
  CAPSULE_OUTLINE,
  CAPSULE_PRIMARY,
  CARD_CLASS,
  ICON_BUTTON,
  SECTION_TITLE_CLASS,
} from '@/components/sales/styles'
import { MskDateTimeInputs, SLOT_KEYS, SLOT_LABELS, type SlotKey } from '@/components/sales/task-fields'
import { useSalesMutation } from '@/components/sales/use-sales-mutation'
import { isOverdue, taskHeadline } from '@/components/sales/utils'
import { isActiveStatus } from '@/lib/sales/labels'
import { fromMskInput, quickSlots, toMskInput, type QuickSlots } from '@/lib/sales/time'
import type { LeadDetail, LeadTaskItem } from '@/lib/sales/types'
import { formatDueRelative, formatMskDateTimeShort } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import { deleteTask, rescheduleTask } from '../actions'
import { AddTaskDialog } from './add-task-dialog'

interface TasksBlockProps {
  lead: LeadDetail
  now: Date
  onComplete: (taskId: string) => void
  pendingTaskId: string | null
}

/** «Следующий шаг»: открытые задачи заявки + «+ Задача». */
export function TasksBlock({ lead, now, onComplete, pendingTaskId }: TasksBlockProps) {
  const [addOpen, setAddOpen] = useState(false)
  const needsNextStep = isActiveStatus(lead.pipelineStatus) && !lead.archivedAt

  return (
    <section aria-labelledby="lead-tasks-title" className={CARD_CLASS}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="lead-tasks-title" className={SECTION_TITLE_CLASS}>
          Следующий шаг
        </h2>
        <button type="button" onClick={() => setAddOpen(true)} className={cn(CAPSULE_OUTLINE, 'px-4')}>
          <Plus className="size-4" aria-hidden="true" />
          Задача
        </button>
      </div>

      {lead.openTasks.length === 0 ? (
        needsNextStep ? (
          <div className="mt-3 rounded-xl bg-danger-bg p-3 text-danger-fg">
            <p className="flex items-center gap-2 font-semibold">
              <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
              Нет следующего шага
            </p>
            <p className="mt-1 text-sm">Заявка без задачи теряется. Запланируй звонок или сообщение.</p>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className={cn(CAPSULE_PRIMARY, 'mt-3 w-full sm:w-auto')}
            >
              <Plus className="size-4" aria-hidden="true" />
              Добавить задачу
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-fg-muted">Открытых задач нет</p>
        )
      ) : (
        <ul className="mt-3 space-y-2">
          {lead.openTasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              now={now}
              onComplete={onComplete}
              pendingTaskId={pendingTaskId}
            />
          ))}
        </ul>
      )}

      <AddTaskDialog leadId={lead.id} open={addOpen} onOpenChange={setAddOpen} />
    </section>
  )
}

function TaskItem({
  task,
  now,
  onComplete,
  pendingTaskId,
}: {
  task: LeadTaskItem
  now: Date
  onComplete: (taskId: string) => void
  pendingTaskId: string | null
}) {
  const { run, isPending } = useSalesMutation()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { title, typeLabel } = taskHeadline(task)
  const overdue = isOverdue(task.dueAt, now)
  const completing = pendingTaskId === task.id
  const busy = isPending || pendingTaskId !== null

  function reschedule(dueAt: Date) {
    run(() => rescheduleTask({ taskId: task.id, dueAt }), {
      success: (data) => `Перенесено: ${formatDueRelative(data.dueAt, new Date())}`,
    })
  }

  return (
    <li
      className={cn(
        'rounded-xl border p-3',
        overdue ? 'border-danger/40 bg-danger-bg/40' : 'border-border bg-surface'
      )}
    >
      <p className="font-semibold break-words text-fg">
        {title}
        {typeLabel && <span className="font-normal text-fg-muted"> · {typeLabel}</span>}
      </p>
      <p className={cn('text-sm', overdue ? 'font-medium text-danger-fg' : 'text-fg-muted')}>
        {formatDueRelative(task.dueAt, now)}
      </p>
      {task.note && <p className="mt-1 text-sm whitespace-pre-line break-words text-fg">{task.note}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onComplete(task.id)}
          className={cn(CAPSULE_PRIMARY, 'flex-1 px-4')}
        >
          {completing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-4" strokeWidth={2.5} aria-hidden="true" />
          )}
          Выполнено
        </button>
        <ReschedulePopover task={task} disabled={busy} onPick={reschedule} />
        <button
          type="button"
          aria-label="Удалить задачу"
          title="Удалить задачу"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
          className={cn(ICON_BUTTON, 'hover:text-danger-fg')}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="bg-surface">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить задачу?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              «{title}» · {formatDueRelative(task.dueAt, now)}. Если это был единственный шаг, заявка
              окажется без следующего шага.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="bg-surface-2">
            <button type="button" onClick={() => setConfirmOpen(false)} className={CAPSULE_OUTLINE}>
              Отмена
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmOpen(false)
                run(() => deleteTask(task.id), { success: 'Задача удалена' })
              }}
              className={CAPSULE_DANGER}
            >
              Удалить
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** «⏰»: быстрые слоты переноса + своя дата/время (МСК). */
function ReschedulePopover({
  task,
  disabled,
  onPick,
}: {
  task: LeadTaskItem
  disabled: boolean
  onPick: (dueAt: Date) => void
}) {
  const [open, setOpen] = useState(false)
  const [openedAt, setOpenedAt] = useState<Date | null>(null)
  const [slots, setSlots] = useState<QuickSlots | null>(null)
  const [custom, setCustom] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')

  function handleOpenChange(next: boolean) {
    if (next) {
      // Слоты считаем в момент открытия (действие пользователя), не при рендере.
      const at = new Date()
      const fresh = quickSlots(at)
      const initial = toMskInput(new Date(task.dueAt).getTime() > at.getTime() ? new Date(task.dueAt) : fresh.tomorrow10)
      setOpenedAt(at)
      setSlots(fresh)
      setCustom(false)
      setDate(initial.date)
      setTime(initial.time)
    }
    setOpen(next)
  }

  function pick(dueAt: Date) {
    setOpen(false)
    onPick(dueAt)
  }

  function pickCustom() {
    const dueAt = fromMskInput(date, time)
    if (!dueAt) {
      toast.error('Укажи дату и время')
      return
    }
    pick(dueAt)
  }

  const options: Array<{ key: SlotKey; at: Date; hint: string | null }> =
    slots && openedAt
      ? SLOT_KEYS.flatMap((key) => {
          const at = slots[key]
          if (!at) return []
          const hint =
            key === 'inOneHour'
              ? formatDueRelative(at, openedAt)
              : key === 'in3days10'
                ? formatMskDateTimeShort(at)
                : null
          return [{ key, at, hint }]
        })
      : []

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Перенести задачу"
          title="Перенести"
          disabled={disabled}
          className={ICON_BUTTON}
        >
          <AlarmClock className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] gap-1 bg-surface p-2">
        <p className="px-2 pt-1 pb-0.5 text-xs font-bold tracking-wide text-fg-muted uppercase">Перенести на</p>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => pick(o.at)}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm text-fg transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none [touch-action:manipulation]"
          >
            <span className="font-medium">{SLOT_LABELS[o.key]}</span>
            {o.hint && <span className="text-xs text-fg-muted">{o.hint}</span>}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={custom}
          onClick={() => setCustom((v) => !v)}
          className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none [touch-action:manipulation]"
        >
          Своя дата и время…
        </button>
        {custom && (
          <div className="space-y-2 px-1 pt-1 pb-1">
            <MskDateTimeInputs date={date} time={time} onDateChange={setDate} onTimeChange={setTime} />
            <button type="button" onClick={pickCustom} className={cn(CAPSULE_PRIMARY, 'w-full')}>
              Перенести
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
