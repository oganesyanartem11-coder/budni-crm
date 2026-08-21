import { Route as RouteIcon } from 'lucide-react'

export default function DeliveryControlLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Загружаем контроль доставки">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-data-orders-bg text-data-orders-ink">
          <RouteIcon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div>
          <p className="text-sm font-semibold text-data-orders-ink">Сегодня</p>
          <h1 className="text-2xl font-bold text-fg">Загружаем контроль доставки</h1>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-card border border-border bg-surface motion-reduce:animate-none" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-64 animate-pulse rounded-3xl border border-border bg-surface motion-reduce:animate-none" />
        <div className="h-64 animate-pulse rounded-3xl border border-border bg-surface motion-reduce:animate-none" />
      </div>
    </div>
  )
}
