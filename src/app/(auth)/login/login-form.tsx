'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from './actions'
import { cn } from '@/lib/utils/cn'
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion'

export function LoginForm() {
  const [pin, setPin] = useState(['', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [success, setSuccess] = useState(false)
  const [isPending, startTransition] = useTransition()
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const router = useRouter()
  const reducedMotion = usePrefersReducedMotion()

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
        setSuccess(true)
        setTimeout(() => {
          router.push('/dashboard')
          router.refresh()
        }, 350)
      } else {
        setError(result.error)
        setShake(true)
        setPin(['', '', '', ''])
        // даём shake начаться до сброса focus
        setTimeout(() => {
          inputRefs.current[0]?.focus()
        }, 100)
      }
    })
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex justify-center gap-3',
          shake && !reducedMotion && 'login-pin-shake'
        )}
        onPaste={handlePaste}
        onAnimationEnd={() => setShake(false)}
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="relative">
            <input
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
                'w-14 h-16 text-center text-2xl font-bold rounded-2xl',
                'bg-bg border border-border',
                'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200',
                'disabled:opacity-50',
                error && 'border-danger focus:border-danger focus:ring-danger/20',
                success && !reducedMotion && 'login-pin-pulse'
              )}
              aria-label={`Цифра PIN ${i + 1}`}
            />
            {pin[i] && !reducedMotion && (
              <span aria-hidden="true" className="login-pin-arc" />
            )}
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-center text-danger">{error}</p>
      )}

      {isPending && (
        <p className="text-sm text-center text-fg-muted">Проверяем...</p>
      )}

      <style>{`
        /* Underline arc — коралловая дуга снизу слота когда цифра введена */
        .login-pin-arc {
          position: absolute;
          bottom: -4px;
          left: 50%;
          transform: translateX(-50%);
          width: calc(100% - 8px);
          height: 4px;
          background: linear-gradient(90deg, transparent 0%, #E85D2A 20%, #E85D2A 80%, transparent 100%);
          border-radius: 999px;
          pointer-events: none;
          opacity: 0;
          animation: login-arc-in 200ms ease-out forwards;
        }
        @keyframes login-arc-in {
          0% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
          100% { opacity: 1; transform: translateX(-50%) translateY(0); }
        }

        /* Shake на ошибке */
        .login-pin-shake {
          animation: login-shake 280ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
        }
        @keyframes login-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }

        /* Pulse на успехе — мятный glow */
        .login-pin-pulse {
          animation: login-pulse 350ms ease-out;
          border-color: var(--color-success) !important;
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success) 35%, transparent);
        }
        @keyframes login-pulse {
          0% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-success) 50%, transparent); }
          50% { transform: scale(1.05); box-shadow: 0 0 0 10px color-mix(in srgb, var(--color-success) 45%, transparent); }
          100% { transform: scale(1); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success) 35%, transparent); }
        }

        /* Reduced motion override (двойная защита) */
        @media (prefers-reduced-motion: reduce) {
          .login-pin-arc,
          .login-pin-shake,
          .login-pin-pulse {
            animation: none !important;
            transition: none !important;
          }
          .login-pin-arc { opacity: 1; transform: translateX(-50%); }
        }
      `}</style>
    </div>
  )
}
