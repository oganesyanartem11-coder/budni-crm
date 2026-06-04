'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { changePin } from './actions'

/** Оставляем только цифры, максимум 4 (совпадает с форматом логина). */
function sanitizePin(v: string): string {
  return v.replace(/\D/g, '').slice(0, 4)
}

export function ChangePinForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmNewPin, setConfirmNewPin] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!/^\d{4}$/.test(currentPin)) {
      setError('Текущий PIN — 4 цифры')
      return
    }
    if (!/^\d{4}$/.test(newPin)) {
      setError('Новый PIN должен состоять из 4 цифр')
      return
    }
    if (newPin !== confirmNewPin) {
      setError('Новый PIN и подтверждение не совпадают')
      return
    }
    if (newPin === currentPin) {
      setError('Новый PIN совпадает с текущим')
      return
    }

    startTransition(async () => {
      const r = await changePin(currentPin, newPin)
      if (r.ok) {
        toast.success('PIN изменён. Войдите заново с новым PIN.')
        setCurrentPin('')
        setNewPin('')
        setConfirmNewPin('')
        // Сессия отозвана на сервере — следующий запрос редиректнет на /login.
        router.refresh()
      } else {
        setError(r.error)
        toast.error(r.error)
      }
    })
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl bg-surface border border-border p-5 space-y-4 max-w-md"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2">
        <KeyRound className="w-5 h-5 text-fg-muted" strokeWidth={1.75} />
        <h3 className="font-semibold text-base">Изменить PIN</h3>
      </div>

      <div>
        <label
          htmlFor="currentPin"
          className="block text-xs uppercase tracking-wider text-fg-muted mb-1"
        >
          Текущий PIN
        </label>
        <input
          id="currentPin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="current-password"
          maxLength={4}
          value={currentPin}
          onChange={(e) => setCurrentPin(sanitizePin(e.target.value))}
          disabled={isPending}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm tracking-[0.4em] font-mono"
        />
      </div>

      <div>
        <label
          htmlFor="newPin"
          className="block text-xs uppercase tracking-wider text-fg-muted mb-1"
        >
          Новый PIN
        </label>
        <input
          id="newPin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="new-password"
          maxLength={4}
          value={newPin}
          onChange={(e) => setNewPin(sanitizePin(e.target.value))}
          disabled={isPending}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm tracking-[0.4em] font-mono"
        />
      </div>

      <div>
        <label
          htmlFor="confirmNewPin"
          className="block text-xs uppercase tracking-wider text-fg-muted mb-1"
        >
          Повторите новый PIN
        </label>
        <input
          id="confirmNewPin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="new-password"
          maxLength={4}
          value={confirmNewPin}
          onChange={(e) => setConfirmNewPin(sanitizePin(e.target.value))}
          disabled={isPending}
          className="w-full px-3 py-2 rounded-xl bg-bg border border-border focus:outline-none focus:border-accent text-sm tracking-[0.4em] font-mono"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <p className="text-xs text-fg-muted">
        После смены PIN все активные сессии будут завершены — войдите заново с
        новым PIN.
      </p>

      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={isPending}
          className="px-5 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? 'Сохраняем…' : 'Изменить PIN'}
        </button>
      </div>
    </form>
  )
}
