import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /**
   * Вариант для sidebar (Color Rebrand v16 — светлый sidebar #ECEDEE). При true:
   *  - dot → var(--color-brand-orange) (#E85D2A) — терракотовый акцент (остаётся);
   *  - текст «Будни» → var(--color-fg), читается на светлом фоне sidebar.
   * По умолчанию (false) — поведение для светлого фона не меняется.
   */
  onDark?: boolean
}

const SIZES = {
  sm: { dot: 'w-3.5 h-3.5', text: 'text-sm font-semibold', gap: 'gap-2' },
  md: { dot: 'w-[18px] h-[18px]', text: 'text-base font-semibold', gap: 'gap-2' },
  lg: { dot: 'w-7 h-7', text: 'text-2xl font-bold', gap: 'gap-3' },
} as const

export function Logo({ href = '/dashboard', size = 'md', className, onDark = false }: LogoProps) {
  const s = SIZES[size]

  const inner = (
    <span className={cn('flex items-center', s.gap, className)}>
      <span
        className={cn(s.dot, 'rounded-full shrink-0', onDark ? 'bg-brand-orange' : 'bg-brand')}
        aria-hidden
      />
      <span className={cn(s.text, 'tracking-tight', onDark ? 'text-fg' : 'text-fg')}>
        Будни
      </span>
    </span>
  )

  if (!href) return inner
  return (
    <Link
      href={href}
      className="inline-flex rounded-sm hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-green/40 focus-visible:ring-offset-2"
    >
      {inner}
    </Link>
  )
}
