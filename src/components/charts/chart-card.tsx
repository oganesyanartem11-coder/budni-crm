import { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

type ChartCardProps = {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode // правый верхний угол: бейдж/кнопка/тогл
  /**
   * Фикс-высота тела карточки. 'auto' — не оборачиваем children в фикс-высоту
   * (используем, когда внутри список/таблица/смесь блоков переменной высоты).
   */
  height?: 'sm' | 'md' | 'lg' | 'auto'
  /** Доп. классы для внутреннего div'а тела карточки (применяются вместе с height). */
  bodyClassName?: string
  /** Опциональный футер под телом карточки. */
  footer?: ReactNode
  className?: string
  children: ReactNode
}

const HEIGHT_CLASS: Record<Exclude<NonNullable<ChartCardProps['height']>, 'auto'>, string> = {
  sm: 'h-40',
  md: 'h-64',
  lg: 'h-80',
}

export function ChartCard({
  title,
  subtitle,
  action,
  height = 'md',
  bodyClassName,
  footer,
  className,
  children,
}: ChartCardProps) {
  const hasHeader = !!title || !!subtitle || !!action
  return (
    <div
      className={cn('rounded-2xl border border-border bg-surface p-5', className)}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {subtitle && <p className="text-xs text-fg-muted mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn(height !== 'auto' && HEIGHT_CLASS[height], bodyClassName)}>
        {children}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  )
}
