import { Route as RouteIcon } from 'lucide-react'

export default function DeliveryLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-5" aria-busy="true" aria-label="Загружаем маршрут">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-data-orders-bg text-data-orders-ink">
          <RouteIcon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-data-orders-ink">Сегодня</p>
          <h1 className="text-2xl font-bold text-fg">Загружаем маршрут</h1>
        </div>
      </div>
      <div className="h-36 animate-pulse rounded-3xl border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-24 animate-pulse rounded-card border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-32 animate-pulse rounded-card border border-border bg-surface motion-reduce:animate-none" />
    </div>
  )
}
