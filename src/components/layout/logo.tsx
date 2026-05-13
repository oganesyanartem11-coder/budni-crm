import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: { dot: 'w-5 h-5', text: 'text-sm font-semibold' },
  md: { dot: 'w-6 h-6', text: 'text-base font-semibold' },
  lg: { dot: 'w-10 h-10', text: 'text-2xl font-bold' },
} as const

export function Logo({ href = '/dashboard', size = 'md', className }: LogoProps) {
  const s = SIZES[size]

  const inner = (
    <span className={cn('flex items-center gap-2', className)}>
      <span className={cn(s.dot, 'rounded-full bg-brand shrink-0')} aria-hidden />
      <span className={cn(s.text, 'tracking-tight text-fg')}>Будни</span>
    </span>
  )

  if (!href) return inner
  return (
    <Link href={href} className="inline-flex hover:opacity-80 transition-opacity">
      {inner}
    </Link>
  )
}
