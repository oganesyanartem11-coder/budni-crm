'use client'
import * as React from 'react'
import { cn } from '@/lib/utils'

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
  ariaLabel?: string
}

export function SegmentedControl<T extends string>({ options, value, onChange, className, size = 'md', ariaLabel }: SegmentedControlProps<T>) {
  const sizeClasses = {
    sm: 'min-h-[44px] px-3 py-2 text-xs',
    md: 'min-h-[44px] px-4 py-2.5 text-sm',
  }
  return (
    <div role="group" aria-label={ariaLabel} className={cn('inline-flex items-center gap-0.5 p-1 rounded-pill bg-surface-2', className)} style={{ boxShadow: 'var(--shadow-card)' }}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            style={{ touchAction: 'manipulation', ...(active ? { background: 'linear-gradient(180deg, #1F2530 0%, #10141A 100%)', boxShadow: 'var(--shadow-capsule)' } : {}) }}
            className={cn(
              sizeClasses[size],
              'rounded-pill font-semibold transition-all whitespace-nowrap',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1',
              active ? 'bg-primary text-primary-foreground' : 'text-fg-muted hover:text-fg',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
