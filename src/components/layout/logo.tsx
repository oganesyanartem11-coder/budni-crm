import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Logo({ href = '/', size = 'md', className }: LogoProps) {
  const sizes = {
    sm: { dot: 'w-2 h-2', text: 'text-base' },
    md: { dot: 'w-2.5 h-2.5', text: 'text-lg' },
    lg: { dot: 'w-3 h-3', text: 'text-xl' },
  }
  const s = sizes[size]

  const inner = (
    <span className={cn('flex items-center gap-2', className)}>
      <span className={cn(s.dot, 'rounded-full bg-brand')} aria-hidden />
      <span className={cn(s.text, 'font-bold tracking-tight text-fg')}>Будни</span>
    </span>
  )

  if (!href) return inner
  return (
    <Link href={href} className="hover:opacity-80 transition-opacity">
      {inner}
    </Link>
  )
}
