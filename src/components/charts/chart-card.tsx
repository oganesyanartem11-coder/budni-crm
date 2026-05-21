import { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

type ChartCardProps = {
  title: string
  subtitle?: string
  action?: ReactNode // правый верхний угол: бейдж/кнопка/тогл
  height?: 'sm' | 'md' | 'lg' // sm=h-40, md=h-64, lg=h-80
  className?: string
  children: ReactNode
}

const HEIGHT_CLASS: Record<NonNullable<ChartCardProps['height']>, string> = {
  sm: 'h-40',
  md: 'h-64',
  lg: 'h-80',
}

export function ChartCard({
  title,
  subtitle,
  action,
  height = 'md',
  className,
  children,
}: ChartCardProps) {
  return (
    <div
      className={cn('rounded-2xl border border-border bg-surface p-5', className)}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {subtitle && <p className="text-xs text-fg-muted mt-0.5">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={HEIGHT_CLASS[height]}>{children}</div>
    </div>
  )
}
