'use client'

import { AlertTriangle, RefreshCw } from 'lucide-react'

export default function DeliveryControlError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-danger/30 bg-surface p-7 text-center shadow-[var(--shadow-card)]" role="alert">
      <span className="mx-auto inline-flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger-fg">
        <AlertTriangle className="size-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-xl font-bold text-fg">Не удалось загрузить контроль доставки</h1>
      <p className="mt-2 text-sm leading-6 text-fg-muted">Проверьте соединение и повторите загрузку. Данные не изменены.</p>
      <button type="button" onClick={reset} className="mt-5 inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 [touch-action:manipulation]">
        <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden="true" />
        Попробовать снова
      </button>
    </div>
  )
}
