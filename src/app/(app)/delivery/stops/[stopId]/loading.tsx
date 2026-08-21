import { MapPin } from 'lucide-react'

export default function StopLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-4" aria-busy="true" aria-label="Загружаем точку">
      <div className="flex min-h-11 items-center gap-2 text-sm font-semibold text-fg-muted">
        <MapPin className="size-5" strokeWidth={1.75} aria-hidden="true" />
        Загружаем точку
      </div>
      <div className="h-72 animate-pulse rounded-3xl border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-40 animate-pulse rounded-card border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-14 animate-pulse rounded-pill bg-primary/20 motion-reduce:animate-none" />
    </div>
  )
}
