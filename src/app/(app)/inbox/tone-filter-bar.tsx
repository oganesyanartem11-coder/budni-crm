'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertTriangle, Frown, Minus, Smile, LayoutGrid, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { TONE_CONFIG, type ToneLabel } from '@/lib/inbox/tone-labels'

interface Props {
  activeTone?: ToneLabel
}

const TONES_ORDER: ToneLabel[] = ['urgent', 'rude', 'neutral', 'thanks']

// Цветовые пары для чипов: неактив (мягкая подложка) / актив (насыщенный + text-surface).
const TONE_CHIP_COLORS: Record<ToneLabel, { idle: string; active: string }> = {
  urgent:  { idle: 'bg-danger-bg text-danger-fg',   active: 'bg-danger text-surface' },
  rude:    { idle: 'bg-warning-bg text-warning-fg', active: 'bg-warning-fg text-surface' },
  thanks:  { idle: 'bg-success-bg text-success-fg', active: 'bg-success text-surface' },
  neutral: { idle: 'bg-neutral-bg text-neutral-fg', active: 'bg-neutral-fg text-surface' },
}

const TONE_ICONS: Record<ToneLabel, LucideIcon> = {
  urgent:  AlertTriangle,
  rude:    Frown,
  thanks:  Smile,
  neutral: Minus,
}

export function ToneFilterBar({ activeTone }: Props) {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function hrefFor(tone: ToneLabel | undefined): string {
    const sp = new URLSearchParams(searchParams.toString())
    if (tone) sp.set('tone', tone)
    else sp.delete('tone')
    const qs = sp.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  const baseChip =
    'inline-flex min-h-11 items-center gap-1.5 px-4 py-2 rounded-pill text-sm font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

  return (
    <nav className="flex flex-wrap gap-2 mb-4" aria-label="Фильтр по тону">
      <Link
        href={hrefFor(undefined)}
        aria-current={!activeTone ? 'true' : undefined}
        className={cn(
          baseChip,
          !activeTone ? 'bg-brand-green-deep text-surface' : 'bg-surface-2 text-fg hover:bg-neutral-bg',
        )}
      >
        <LayoutGrid className="h-4 w-4" aria-hidden />
        Все
      </Link>
      {TONES_ORDER.map((tone) => {
        const cfg = TONE_CONFIG[tone]
        const active = activeTone === tone
        const colors = TONE_CHIP_COLORS[tone]
        const Icon = TONE_ICONS[tone]
        return (
          <Link
            key={tone}
            href={hrefFor(tone)}
            aria-current={active ? 'true' : undefined}
            className={cn(baseChip, active ? colors.active : colors.idle)}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {cfg.ru}
          </Link>
        )
      })}
    </nav>
  )
}
