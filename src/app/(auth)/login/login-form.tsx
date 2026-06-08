'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { loginAction } from './actions'
import { getHomeForRole } from '@/lib/auth/roles'
import { cn } from '@/lib/utils/cn'
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion'

export function LoginForm() {
  const [pin, setPin] = useState(['', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [success, setSuccess] = useState(false)
  const [merged, setMerged] = useState(false)
  const [isPending, startTransition] = useTransition()
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const successTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const router = useRouter()
  const reducedMotion = usePrefersReducedMotion()

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    return () => {
      successTimers.current.forEach(clearTimeout)
      successTimers.current = []
    }
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
        // P7: redirect на home роли (getHomeForRole), а не хардкод /dashboard —
        // COURIER→/delivery, CHEF→/production без лишнего bounce через requireRole.
        const home = getHomeForRole(result.role)
        if (reducedMotion) {
          // Reduced-motion: пилюля+галочка мгновенно, без stagger, редирект через 600мс.
          setSuccess(true)
          setMerged(true)
          successTimers.current.push(
            setTimeout(() => {
              router.push(home)
              router.refresh()
            }, 600)
          )
        } else {
          // t=0: glow по цифрам (stagger). t=480: морф в пилюлю. t=1300: редирект.
          setSuccess(true)
          successTimers.current.push(
            setTimeout(() => setMerged(true), 480)
          )
          successTimers.current.push(
            setTimeout(() => {
              router.push(home)
              router.refresh()
            }, 1300)
          )
        }
      } else {
        // Сбрасываем success-анимацию и таймеры, чтобы не осталась застывшая
        // зелёная пилюля и поле было готово к повторному вводу.
        successTimers.current.forEach(clearTimeout)
        successTimers.current = []
        setSuccess(false)
        setMerged(false)
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
          'login-success-stage relative mx-auto w-fit',
          merged && 'merged'
        )}
      >
        <div
          className={cn(
            'pin-row flex justify-center gap-3',
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
                disabled={isPending || success}
                style={{ animationDelay: reducedMotion ? '0ms' : `${i * 80}ms` }}
                className={cn(
                  'w-14 h-16 text-center text-2xl font-bold rounded-2xl',
                  'bg-bg border border-border',
                  'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200',
                  'disabled:opacity-50',
                  error && 'border-danger focus:border-danger focus:ring-danger/20',
                  success && 'login-success-glow'
                )}
                aria-label={`Цифра PIN ${i + 1}`}
              />
              {pin[i] && !reducedMotion && (
                <span aria-hidden="true" className="login-pin-arc" />
              )}
            </div>
          ))}
        </div>
        {success && (
          <div className="success-pill" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none">
              <path className="success-check" d="M 5 12.5 L 10 17.5 L 19 8" stroke="#fff" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
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

        /* Success — glow по цифрам → морф ячеек в зелёную пилюлю с галочкой */
        .login-success-glow {
          border-color: #1D9E75 !important;
          color: #0F6E56 !important;
          animation: cellGlow 0.55s ease both;
        }
        @keyframes cellGlow {
          0%   { transform: scale(1); background-color: var(--color-bg); box-shadow: 0 0 0 0 rgba(29,158,117,0); }
          40%  { transform: scale(1.08); }
          100% { transform: scale(1); background-color: #E1F5EE; box-shadow: 0 0 0 4px rgba(29,158,117,0.18), 0 0 18px 2px rgba(29,158,117,0.32); }
        }
        .success-pill {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #0F6E56;
          border-radius: 16px;
          box-shadow: 0 0 0 4px rgba(29,158,117,0.18), 0 8px 24px rgba(15,110,86,0.35);
          opacity: 0;
          transform: scale(0.7);
          pointer-events: none;
        }
        .merged .pin-row {
          opacity: 0;
          transform: scale(0.88);
          transition: opacity 0.32s ease 0.45s, transform 0.32s ease 0.45s;
          pointer-events: none;
        }
        .merged .success-pill {
          opacity: 1;
          transform: scale(1);
          transition: opacity 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.45s, transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) 0.45s;
        }
        .success-check {
          stroke-dasharray: 30;
          stroke-dashoffset: 30;
        }
        .merged .success-check {
          stroke-dashoffset: 0;
          transition: stroke-dashoffset 0.42s ease-out 0.75s;
        }

        /* Reduced motion override (двойная защита) */
        @media (prefers-reduced-motion: reduce) {
          .login-pin-arc,
          .login-pin-shake {
            animation: none !important;
            transition: none !important;
          }
          .login-pin-arc { opacity: 1; transform: translateX(-50%); }
          .login-success-glow { animation: none !important; }
          .merged .pin-row { transition: none !important; }
          .merged .success-pill { transition: none !important; }
          .merged .success-check { transition: none !important; }
        }
      `}</style>
    </div>
  )
}
