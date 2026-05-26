import { TONE_CONFIG, type ToneLabel } from '@/lib/inbox/tone-labels'
import { cn } from '@/lib/utils/cn'

interface Props {
  tone: ToneLabel
  size?: 'sm' | 'md'
}

const VARIANT_CLASSES: Record<typeof TONE_CONFIG[ToneLabel]['variant'], string> = {
  success: 'bg-success/15 text-success-fg',
  muted:   'bg-fg/5 text-fg-muted',
  warning: 'bg-warning/15 text-warning-fg',
  danger:  'bg-danger/15 text-danger-fg',
}

export function ToneChip({ tone, size = 'md' }: Props) {
  const cfg = TONE_CONFIG[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        VARIANT_CLASSES[cfg.variant],
      )}
      title={cfg.ru}
    >
      <span aria-hidden>{cfg.emoji}</span>
      {size === 'md' && <span>{cfg.ru}</span>}
    </span>
  )
}
