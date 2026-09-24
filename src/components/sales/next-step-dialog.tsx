'use client'

import { useId, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, TriangleAlert } from 'lucide-react'
import type { SalesTaskType } from '@prisma/client'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { changeLeadStatus, createTask } from '@/app/(app)/sales/actions'
import { PIPELINE_STATUS_RU, TASK_TYPE_RU } from '@/lib/sales/labels'
import { fromMskInput, quickSlots, toMskInput } from '@/lib/sales/time'
import type { CompleteTaskResult } from '@/lib/sales/types'
import { formatDueRelative, pluralize } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import {
  CAPSULE_PRIMARY,
  CHOICE_CHIP_ACTIVE,
  CHOICE_CHIP_BASE,
  CHOICE_CHIP_IDLE,
  DIALOG_CONTENT_CLASS,
  FIELD_LABEL_CLASS,
  TEXTAREA_CLASS,
} from './styles'
import {
  DuePicker,
  MskDateTimeInputs,
  TaskTypeChips,
  initialDueChoice,
  resolveDue,
  type DueChoice,
} from './task-fields'

/**
 * Sprint 8.0 «Продажи»: «Задача выполнена. Что дальше?» — общая модалка для
 * списка /sales и карточки заявки. Закрывается ТОЛЬКО кнопкой «Готово»
 * (клик вне/Esc заблокированы, крестика нет): менеджер обязан осознанно
 * выбрать следующий шаг или явно «Без следующего шага».
 */

interface NextStepDialogProps {
  open: boolean
  result: CompleteTaskResult | null
  /** Вызывается после успешного «Готово» — родитель сбрасывает result. */
  onDone: () => void
}

export function NextStepDialog({ open, result, onDone }: NextStepDialogProps) {
  return (
    <Dialog
      open={open && result !== null}
      onOpenChange={() => {
        /* закрытие только кнопкой «Готово» */
      }}
    >
      {result && (
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          className={DIALOG_CONTENT_CLASS}
        >
          <NextStepBody key={result.task.id} result={result} onDone={onDone} />
        </DialogContent>
      )}
    </Dialog>
  )
}

type StepKey = 'call_tomorrow' | 'write_3days' | 'proposal_tomorrow' | 'trial' | 'custom' | 'none'

const PRESET_STEPS: Array<{
  key: StepKey
  label: string
  type: SalesTaskType
  slot: 'tomorrow10' | 'in3days10'
}> = [
  { key: 'call_tomorrow', label: 'Позвонить завтра 10:00', type: 'CALL', slot: 'tomorrow10' },
  { key: 'write_3days', label: 'Написать через 3 дня', type: 'WRITE', slot: 'in3days10' },
  { key: 'proposal_tomorrow', label: 'Отправить КП завтра 10:00', type: 'SEND_PROPOSAL', slot: 'tomorrow10' },
]

function NextStepBody({ result, onDone }: { result: CompleteTaskResult; onDone: () => void }) {
  const router = useRouter()
  const switchId = useId()
  const noteId = useId()
  const [isPending, startTransition] = useTransition()

  // Момент открытия модалки (действие пользователя) — от него считаем слоты.
  const [openedAt] = useState(() => new Date())
  const slots = useMemo(() => quickSlots(openedAt), [openedAt])

  const suggested = result.suggestedStatus
  const [moveStatus, setMoveStatus] = useState(suggested !== null)
  const [step, setStep] = useState<StepKey | null>(null)
  const [trialDue, setTrialDue] = useState(() => toMskInput(slots.tomorrow10))
  const [customType, setCustomType] = useState<SalesTaskType>('CALL')
  const [customDue, setCustomDue] = useState<DueChoice>(() => initialDueChoice(slots))
  const [customNote, setCustomNote] = useState('')

  const otherCount = result.otherOpenTasksCount
  const needsChoice = step === null && !result.hasOtherOpenTasks

  function buildTask(): { type: SalesTaskType; dueAt: Date; note: string | null } | null | 'invalid' {
    if (step === null || step === 'none') return null
    const preset = PRESET_STEPS.find((p) => p.key === step)
    if (preset) return { type: preset.type, dueAt: slots[preset.slot], note: null }
    if (step === 'trial') {
      const dueAt = fromMskInput(trialDue.date, trialDue.time)
      if (!dueAt) {
        toast.error('Укажи дату и время пробного дня')
        return 'invalid'
      }
      return { type: 'TRIAL', dueAt, note: null }
    }
    const dueAt = resolveDue(customDue, slots)
    if (!dueAt) {
      toast.error('Укажи дату и время задачи')
      return 'invalid'
    }
    return { type: customType, dueAt, note: customNote.trim() || null }
  }

  function handleDone() {
    if (needsChoice) return
    const task = buildTask()
    if (task === 'invalid') return
    const statusTarget = moveStatus ? suggested : null

    startTransition(async () => {
      try {
        if (statusTarget) {
          const r = await changeLeadStatus({ leadId: result.leadId, status: statusTarget })
          if (!r.ok) {
            toast.error(r.error)
            return
          }
        }
        if (task) {
          const r = await createTask({
            leadId: result.leadId,
            type: task.type,
            dueAt: task.dueAt,
            note: task.note,
          })
          if (!r.ok) {
            toast.error(r.error)
            return
          }
        }
        if (task) {
          toast.success(`Следующий шаг: ${TASK_TYPE_RU[task.type]} · ${formatDueRelative(task.dueAt, new Date())}`)
        } else if (statusTarget) {
          toast.success(`Стадия: ${PIPELINE_STATUS_RU[statusTarget]}`)
        } else {
          toast.success('Задача выполнена')
        }
        onDone()
        router.refresh()
      } catch {
        toast.error('Не удалось сохранить. Проверь связь и попробуй ещё раз')
      }
    })
  }

  function chipClass(key: StepKey) {
    const active = step === key
    if (key === 'none') {
      return cn(
        CHOICE_CHIP_BASE,
        active
          ? 'border border-fg-muted bg-neutral-bg text-fg'
          : 'border border-transparent bg-surface-2 text-fg-muted hover:text-fg'
      )
    }
    return cn(CHOICE_CHIP_BASE, active ? CHOICE_CHIP_ACTIVE : CHOICE_CHIP_IDLE)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-bold leading-snug">Задача выполнена. Что дальше?</DialogTitle>
        <DialogDescription className="break-words">
          {result.leadLabel} · {result.task.title}
        </DialogDescription>
      </DialogHeader>

      {result.hasOtherOpenTasks && (
        <p className="rounded-xl bg-info-bg px-3 py-2 text-sm text-info-fg">
          Есть ещё {otherCount}{' '}
          {pluralize(otherCount, ['открытая задача', 'открытые задачи', 'открытых задач'])}
        </p>
      )}

      {suggested && (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2">
          <label htmlFor={switchId} className="min-w-0 flex-1 text-sm font-medium text-fg">
            Перевести в «{PIPELINE_STATUS_RU[suggested]}»
          </label>
          <Switch
            id={switchId}
            checked={moveStatus}
            onCheckedChange={setMoveStatus}
            disabled={isPending}
          />
        </div>
      )}

      <div className="space-y-2">
        <p className={FIELD_LABEL_CLASS}>Следующий шаг</p>
        <div role="radiogroup" aria-label="Следующий шаг" className="flex flex-wrap gap-2">
          {PRESET_STEPS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={step === p.key}
              disabled={isPending}
              onClick={() => setStep(p.key)}
              className={chipClass(p.key)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={step === 'trial'}
            disabled={isPending}
            onClick={() => setStep('trial')}
            className={chipClass('trial')}
          >
            Пробный день (дата)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={step === 'custom'}
            disabled={isPending}
            onClick={() => setStep('custom')}
            className={chipClass('custom')}
          >
            Своё…
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={step === 'none'}
            disabled={isPending}
            onClick={() => setStep('none')}
            className={chipClass('none')}
          >
            Без следующего шага
          </button>
        </div>
      </div>

      {step === 'trial' && (
        <MskDateTimeInputs
          date={trialDue.date}
          time={trialDue.time}
          disabled={isPending}
          onDateChange={(date) => setTrialDue((prev) => ({ ...prev, date }))}
          onTimeChange={(time) => setTrialDue((prev) => ({ ...prev, time }))}
        />
      )}

      {step === 'custom' && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <TaskTypeChips value={customType} onChange={setCustomType} disabled={isPending} />
          <DuePicker slots={slots} now={openedAt} value={customDue} onChange={setCustomDue} disabled={isPending} />
          <div>
            <label htmlFor={noteId} className={FIELD_LABEL_CLASS}>
              Заметка
            </label>
            <textarea
              id={noteId}
              rows={2}
              value={customNote}
              disabled={isPending}
              onChange={(e) => setCustomNote(e.target.value)}
              placeholder="Что сделать, о чём договорились"
              className={TEXTAREA_CLASS}
            />
          </div>
        </div>
      )}

      {step === 'none' && !result.hasOtherOpenTasks && (
        <p className="flex gap-2 rounded-xl bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>Заявка попадёт в «Без следующего шага» — не забудь вернуться к ней.</span>
        </p>
      )}

      <DialogFooter className="bg-surface-2">
        <button
          type="button"
          onClick={handleDone}
          disabled={isPending || needsChoice}
          className={cn(CAPSULE_PRIMARY, 'w-full sm:w-auto')}
        >
          {isPending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {isPending ? 'Сохраняем…' : 'Готово'}
        </button>
        {needsChoice && (
          <p className="text-center text-xs text-fg-muted sm:order-first sm:mr-auto sm:self-center sm:text-left">
            Выбери следующий шаг или «Без следующего шага»
          </p>
        )}
      </DialogFooter>
    </>
  )
}
