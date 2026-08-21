import Link from 'next/link'
import { ArrowLeft, RouteOff } from 'lucide-react'

export default function ManagerRouteNotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-border bg-surface p-7 text-center shadow-[var(--shadow-card)]">
      <span className="mx-auto inline-flex size-12 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
        <RouteOff className="size-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-xl font-bold text-fg">Маршрут недоступен</h1>
      <p className="mt-2 text-sm leading-6 text-fg-muted">Он мог быть удалён или сформирован заново после переназначения.</p>
      <Link href="/delivery/control" className="mt-5 inline-flex min-h-12 items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
        <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
        К контролю доставки
      </Link>
    </div>
  )
}
