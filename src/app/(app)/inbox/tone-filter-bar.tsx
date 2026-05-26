'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils/cn'
import { TONE_CONFIG, type ToneLabel } from '@/lib/inbox/tone-labels'

interface Props {
  activeTone?: ToneLabel
}

const TONES_ORDER: ToneLabel[] = ['urgent', 'rude', 'neutral', 'thanks']

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

  const chipClass = (active: boolean) =>
    cn(
      'inline-flex items-center gap-1 px-3 py-1.5 rounded-pill text-xs font-medium transition-colors',
      active ? 'bg-fg text-bg' : 'bg-fg/5 text-fg-muted hover:bg-fg/10 hover:text-fg',
    )

  return (
    <nav className="flex flex-wrap gap-1.5 mb-3" aria-label="Фильтр по тону">
      <Link href={hrefFor(undefined)} className={chipClass(!activeTone)}>
        Все
      </Link>
      {TONES_ORDER.map((tone) => {
        const cfg = TONE_CONFIG[tone]
        return (
          <Link
            key={tone}
            href={hrefFor(tone)}
            className={chipClass(activeTone === tone)}
          >
            <span aria-hidden>{cfg.emoji}</span>
            {cfg.ru}
          </Link>
        )
      })}
    </nav>
  )
}
