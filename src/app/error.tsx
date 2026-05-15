'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Logo } from '@/components/layout/logo'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

export default function ErrorBoundary({ error, reset }: Props) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 bg-bg">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex justify-center">
          <Logo size="lg" href={undefined} />
        </div>

        <div
          className="rounded-2xl bg-surface p-8 border border-border"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="flex flex-col items-center text-center space-y-4">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-danger-bg">
              <AlertTriangle className="h-6 w-6 text-danger-fg" />
            </div>

            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">
                Что-то пошло не так
              </h1>
              <p className="text-sm text-fg-muted">
                Мы уже знаем об ошибке. Попробуйте обновить страницу или
                вернуться позже.
              </p>
            </div>

            {error.digest && (
              <p className="text-xs font-mono text-fg-subtle">
                Код ошибки: {error.digest}
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-2 w-full pt-2">
              <button
                type="button"
                onClick={() => reset()}
                className="flex-1 px-4 py-2 rounded-pill bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
              >
                Попробовать снова
              </button>
              <Link
                href="/dashboard"
                className="flex-1 px-4 py-2 rounded-pill border border-border-strong text-fg text-sm font-medium text-center hover:bg-bg"
              >
                На дашборд
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
