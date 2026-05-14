import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface Props {
  icon: LucideIcon
  title: string
  description?: string
  cta?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, cta, className }: Props) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-surface border border-border p-12 flex flex-col items-center justify-center text-center',
        className
      )}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <Icon className="w-12 h-12 text-fg-subtle mb-4" strokeWidth={1.5} />
      <p className="font-medium text-fg mb-1">{title}</p>
      {description && <p className="text-sm text-fg-muted max-w-sm">{description}</p>}
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  )
}
