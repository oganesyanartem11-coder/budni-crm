'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Calendar, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import type { ReportPreset } from '@/lib/utils/week'

interface Props {
  preset: ReportPreset
  rangeFromIso: string
  rangeToIso: string
  /**
   * Базовый путь для URL writeBack. По умолчанию берётся из usePathname() —
   * т.е. селектор пишет в текущий маршрут. Передать явно, если нужно навигировать
   * из одного раздела в другой (например, кнопка дашборда → /reports).
   */
  basePath?: string
}

const MAIN_PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'this_week', label: 'Эта неделя' },
  { key: 'this_month', label: 'Этот месяц' },
  { key: 'this_year', label: 'Год' },
]

const SECONDARY_PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'yesterday', label: 'Вчера' },
  { key: 'last_week', label: 'Прошлая неделя' },
  { key: 'last_month', label: 'Прошлый месяц' },
  { key: 'this_quarter', label: 'Квартал' },
  { key: 'custom', label: 'Произвольно' },
]

export function PeriodSelector({ preset, rangeFromIso, rangeToIso, basePath }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const fromDate = rangeFromIso.slice(0, 10)
  const toDate = rangeToIso.slice(0, 10)

  const [customFrom, setCustomFrom] = useState(fromDate)
  const [customTo, setCustomTo] = useState(toDate)

  const target = basePath ?? pathname

  function applyPreset(p: ReportPreset) {
    const params = new URLSearchParams()
    params.set('preset', p)
    startTransition(() => router.push(`${target}?${params.toString()}`))
  }

  function applyCustom() {
    const params = new URLSearchParams()
    params.set('preset', 'custom')
    params.set('from', customFrom)
    params.set('to', customTo)
    startTransition(() => router.push(`${target}?${params.toString()}`))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {MAIN_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p.key)}
            disabled={isPending}
            style={preset === p.key ? { background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' } : undefined}
            className={cn(
              'inline-flex items-center min-h-[44px] px-4 rounded-pill text-sm font-medium transition-colors disabled:opacity-50',
              preset === p.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface text-fg-muted hover:text-fg hover:bg-surface-2'
            )}
          >
            {p.label}
          </button>
        ))}
        <SecondaryPresetMenu preset={preset} onSelect={applyPreset} disabled={isPending} />
      </div>

      {preset === 'custom' && (
        <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
          <Calendar className="w-4 h-4 text-fg-muted shrink-0" />
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          />
          <span className="text-fg-muted text-sm">→</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="min-h-[44px] px-3 py-2.5 rounded-xl bg-surface border border-border focus:outline-none focus:border-accent transition-colors text-sm"
          />
          <button
            type="button"
            onClick={applyCustom}
            disabled={isPending}
            style={{ background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' }}
            className="inline-flex items-center min-h-[44px] px-5 rounded-pill bg-primary text-primary-foreground font-medium text-sm hover:opacity-95 transition-opacity disabled:opacity-50"
          >
            Применить
          </button>
        </div>
      )}
    </div>
  )
}

function SecondaryPresetMenu({
  preset,
  onSelect,
  disabled,
}: {
  preset: ReportPreset
  onSelect: (p: ReportPreset) => void
  disabled: boolean
}) {
  const activeSecondary = SECONDARY_PRESETS.find((p) => p.key === preset)
  const label = activeSecondary?.label ?? 'Другой период'
  const isActive = !!activeSecondary

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          style={isActive ? { background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' } : undefined}
          className={cn(
            'inline-flex items-center gap-1 min-h-[44px] px-4 rounded-pill text-sm font-medium transition-colors disabled:opacity-50',
            isActive
              ? 'bg-primary text-primary-foreground'
              : 'bg-surface text-fg-muted hover:text-fg hover:bg-surface-2'
          )}
        >
          {label}
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {SECONDARY_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.key}
            onClick={() => onSelect(p.key)}
            className={cn('cursor-pointer', preset === p.key && 'font-semibold')}
          >
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
