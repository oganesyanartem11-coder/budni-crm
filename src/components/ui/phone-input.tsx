'use client'

import { forwardRef } from 'react'
import { formatPhoneMask } from '@/lib/utils/format'
import { cn } from '@/lib/utils/cn'

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string
  onChange: (value: string) => void
  hasError?: boolean
}

export const PhoneInput = forwardRef<HTMLInputElement, Props>(function PhoneInput(
  { value, onChange, hasError, className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      placeholder="+7 (___) ___-__-__"
      value={value}
      onChange={(e) => {
        const formatted = formatPhoneMask(e.target.value)
        onChange(formatted)
      }}
      className={cn(
        'w-full px-3 py-2.5 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent transition-colors tabular-nums',
        hasError && 'border-danger',
        className
      )}
      {...rest}
    />
  )
})
