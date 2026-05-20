'use client'

import { CalendarDays } from 'lucide-react'
import { ru } from 'date-fns/locale'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDateNumeric } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

export interface MondayPickerProps {
  value: Date | undefined
  onChange: (date: Date | undefined) => void
  disabled?: boolean
}

// Конвертирует Date в 'YYYY-MM-DD' по ЛОКАЛЬНОЙ дате (не UTC).
// Backend approveMenuImport парсит как UTC midnight, isMonday использует getUTCDay().
// Если пользователь выбрал в UI понедельник 25.05 (локально), мы шлём '2026-05-25',
// backend строит Date.UTC от него → 2026-05-25T00:00:00Z → getUTCDay()=1. Чисто.
// `.toISOString().slice(0,10)` на западных TZ дал бы предыдущий день — нельзя.
export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfToday(): Date {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return t
}

export function MondayPicker({ value, onChange, disabled }: MondayPickerProps) {
  const today = startOfToday()
  const label = value ? formatDateNumeric(value) : 'Выберите понедельник'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'w-full inline-flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-border bg-bg text-sm transition-colors',
            'hover:border-border-strong focus:outline-none focus:border-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            !value && 'text-fg-muted'
          )}
        >
          <span className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-fg-muted" />
            {label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        align="start"
      >
        <Calendar
          mode="single"
          locale={ru}
          weekStartsOn={1}
          selected={value}
          onSelect={onChange}
          disabled={(date) => date.getDay() !== 1 || date < today}
        />
      </PopoverContent>
    </Popover>
  )
}
