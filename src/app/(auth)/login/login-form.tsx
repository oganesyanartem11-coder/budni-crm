'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from './actions'
import { cn } from '@/lib/utils/cn'

export function LoginForm() {
  const [pin, setPin] = useState(['', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const router = useRouter()

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  function handleDigitChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1) // только последняя цифра
    const newPin = [...pin]
    newPin[index] = digit
    setPin(newPin)
    setError(null)

    // Авто-переход к следующему полю
    if (digit && index < 3) {
      inputRefs.current[index + 1]?.focus()
    }

    // Когда все 4 цифры введены — авто-сабмит
    if (newPin.every((d) => d) && newPin.join('').length === 4) {
      submit(newPin.join(''))
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !pin[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
    if (pasted.length === 4) {
      const newPin = pasted.split('')
      setPin(newPin)
      submit(pasted)
    }
  }

  function submit(pinValue: string) {
    setError(null)
    startTransition(async () => {
      const result = await loginAction(pinValue)
      if (result.ok) {
        router.push('/dashboard')
        router.refresh()
      } else {
        setError(result.error)
        setPin(['', '', '', ''])
        inputRefs.current[0]?.focus()
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center gap-3" onPaste={handlePaste}>
        {[0, 1, 2, 3].map((i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={pin[i]}
            onChange={(e) => handleDigitChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={isPending}
            className={cn(
              'w-14 h-16 text-center text-2xl font-bold rounded-xl',
              'bg-bg border-2 border-border',
              'focus:outline-none focus:border-fg focus:ring-2 focus:ring-fg/20 transition-all duration-150',
              'disabled:opacity-50',
              error && 'border-danger focus:border-danger focus:ring-danger/20'
            )}
            aria-label={`Цифра PIN ${i + 1}`}
          />
        ))}
      </div>

      {error && (
        <p className="text-sm text-center text-danger">{error}</p>
      )}

      {isPending && (
        <p className="text-sm text-center text-fg-muted">Проверяем...</p>
      )}
    </div>
  )
}
