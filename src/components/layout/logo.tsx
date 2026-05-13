import Image from 'next/image'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'

interface LogoProps {
  href?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: { px: 32, rounded: 'rounded-xl', shadow: 'shadow-sm' },
  md: { px: 48, rounded: 'rounded-2xl', shadow: 'shadow-sm' },
  lg: { px: 180, rounded: 'rounded-3xl', shadow: 'shadow-lg' },
} as const

export function Logo({ href = '/dashboard', size = 'md', className }: LogoProps) {
  const s = SIZES[size]

  const img = (
    <Image
      src="/branding/logo-v2.png"
      alt="Будни CRM"
      width={s.px}
      height={s.px}
      priority={size === 'lg'}
      className={cn(s.rounded, s.shadow, 'block', className)}
    />
  )

  if (!href) return img
  return (
    <Link href={href} className="hover:opacity-80 transition-opacity inline-block">
      {img}
    </Link>
  )
}
