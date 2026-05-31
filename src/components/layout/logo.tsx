import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /**
   * Вариант для sidebar (Color Rebrand v16 — светлый sidebar #ECEDEE). При true
   * текст «Будни» → var(--color-fg), читается на светлом фоне. По умолчанию тоже
   * text-fg (на /login). Оставлен как флаг для будущих тёмных контекстов.
   */
  onDark?: boolean
  /**
   * Bug 7.24-6: для collapsed-sidebar (hover-expand). При true текст «Будни»
   * скрыт (opacity-0) и проявляется на group-hover родителя <aside> — как лейблы
   * навигации. В collapsed (72px) остаётся только мятный кружок, текст не клипается.
   */
  collapsible?: boolean
}

const SIZES = {
  sm: { dot: 'w-3.5 h-3.5', text: 'text-sm font-semibold', gap: 'gap-2' },
  md: { dot: 'w-[18px] h-[18px]', text: 'text-base font-semibold', gap: 'gap-2' },
  lg: { dot: 'w-7 h-7', text: 'text-2xl font-bold', gap: 'gap-3' },
} as const

export function Logo({ href = '/dashboard', size = 'md', className, collapsible = false }: LogoProps) {
  const s = SIZES[size]

  const inner = (
    <span className={cn('flex items-center', s.gap, className)}>
      {/* Bug 7.24-6 / latent fix: было bg-brand (удалённый токен → невидим на /login)
          и bg-brand-orange в sidebar. Теперь всегда мятная точка var(--color-mint). */}
      <span className={cn(s.dot, 'rounded-full shrink-0 bg-mint')} aria-hidden />
      <span
        className={cn(
          s.text,
          'tracking-tight text-fg whitespace-nowrap',
          collapsible &&
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-50 motion-reduce:transition-none',
        )}
      >
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
