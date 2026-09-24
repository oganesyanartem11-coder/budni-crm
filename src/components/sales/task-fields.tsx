'use client'

import type { SalesTaskType } from '@prisma/client'
import { TASK_TYPES, TASK_TYPE_RU } from '@/lib/sales/labels'
import { fromMskInput, toMskInput, type QuickSlots } from '@/lib/sales/time'
import { formatDueRelative } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'
import {
  CHOICE_CHIP_ACTIVE,
  CHOICE_CHIP_BASE,
  CHOICE_CHIP_IDLE,
  INPUT_CLASS,
} from './styles'

/**
 * Sprint 8.0 «Продажи»: общие поля задачи — чипы типа, пара date+time (МСК),
 * выбор срока из быстрых слотов. Используются в «+ Задача», NextStepDialog и
 * переносе задачи. Все даты — через src/lib/sales/time (МСК-хелперы).
 */

// ---------- Тип задачи ----------

export function TaskTypeChips({
  value,
  onChange,
  disabled,
}: {
  value: SalesTaskType
  onChange: (type: SalesTaskType) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Тип задачи" className="flex flex-wrap gap-2">
      {TASK_TYPES.map((type) => {
        const active = type === value
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(type)}
            className={cn(CHOICE_CHIP_BASE, active ? CHOICE_CHIP_ACTIVE : CHOICE_CHIP_IDLE)}
          >
            {TASK_TYPE_RU[type]}
          </button>
        )
      })}
    </div>
  )
}

// ---------- Дата + время (МСК) ----------

const DATE_TIME_INPUT_CLASS = cn(
  INPUT_CLASS,
  'min-w-0 appearance-none tabular-nums [&::-webkit-date-and-time-value]:text-left'
)

export function MskDateTimeInputs({
  date,
  time,
  onDateChange,
  onTimeChange,
  disabled,
}: {
  date: string
  time: string
  onDateChange: (value: string) => void
  onTimeChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
      <label className="min-w-0">
        <span className="mb-1 block text-xs text-fg-muted">Дата</span>
        <input
          type="date"
          value={date}
          disabled={disabled}
          onChange={(e) => onDateChange(e.target.value)}
          className={DATE_TIME_INPUT_CLASS}
        />
      </label>
      <label className="min-w-0">
        <span className="mb-1 block text-xs text-fg-muted">Время, МСК</span>
        <input
          type="time"
          value={time}
          disabled={disabled}
          onChange={(e) => onTimeChange(e.target.value)}
          className={DATE_TIME_INPUT_CLASS}
        />
      </label>
    </div>
  )
}

// ---------- Срок: быстрые слоты или своё время ----------

export type SlotKey = 'inOneHour' | 'todayEvening' | 'tomorrow10' | 'in3days10'

export const SLOT_KEYS: SlotKey[] = ['inOneHour', 'todayEvening', 'tomorrow10', 'in3days10']

export const SLOT_LABELS: Record<SlotKey, string> = {
  inOneHour: 'Через час',
  todayEvening: 'Сегодня 18:00',
  tomorrow10: 'Завтра 10:00',
  in3days10: 'Через 3 дня',
}

export interface DueChoice {
  key: SlotKey | 'custom'
  /** Для key='custom': «YYYY-MM-DD» и «HH:mm» в МСК. */
  date: string
  time: string
}

/** Стартовый выбор срока; поля «своего времени» предзаполнены завтра 10:00. */
export function initialDueChoice(slots: QuickSlots, key: DueChoice['key'] = 'tomorrow10'): DueChoice {
  const { date, time } = toMskInput(slots.tomorrow10)
  return { key, date, time }
}

/** Выбор → UTC-инстант (null — своё время не заполнено/невалидно). */
export function resolveDue(choice: DueChoice, slots: QuickSlots): Date | null {
  if (choice.key === 'custom') return fromMskInput(choice.date, choice.time)
  return slots[choice.key]
}

export function DuePicker({
  slots,
  now,
  value,
  onChange,
  disabled,
}: {
  slots: QuickSlots
  now: Date
  value: DueChoice
  onChange: (choice: DueChoice) => void
  disabled?: boolean
}) {
  const keys = SLOT_KEYS.filter((key) => slots[key] !== null)
  const resolved = resolveDue(value, slots)
  const inPast = resolved !== null && resolved.getTime() < now.getTime()

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Срок" className="flex flex-wrap gap-2">
        {keys.map((key) => {
          const active = value.key === key
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange({ ...value, key })}
              className={cn(CHOICE_CHIP_BASE, active ? CHOICE_CHIP_ACTIVE : CHOICE_CHIP_IDLE)}
            >
              {SLOT_LABELS[key]}
            </button>
          )
        })}
        <button
          type="button"
          role="radio"
          aria-checked={value.key === 'custom'}
          disabled={disabled}
          onClick={() => onChange({ ...value, key: 'custom' })}
          className={cn(
            CHOICE_CHIP_BASE,
            value.key === 'custom' ? CHOICE_CHIP_ACTIVE : CHOICE_CHIP_IDLE
          )}
        >
          Своё время
        </button>
      </div>

      {value.key === 'custom' && (
        <MskDateTimeInputs
          date={value.date}
          time={value.time}
          disabled={disabled}
          onDateChange={(date) => onChange({ ...value, date })}
          onTimeChange={(time) => onChange({ ...value, time })}
        />
      )}

      <p className={cn('text-sm', inPast ? 'text-danger-fg' : 'text-fg-muted')} aria-live="polite">
        {resolved ? (
          <>
            Срок: <span className="font-semibold">{formatDueRelative(resolved, now)}</span>
            {inPast && ' — время уже прошло'}
          </>
        ) : (
          'Укажи дату и время'
        )}
      </p>
    </div>
  )
}
