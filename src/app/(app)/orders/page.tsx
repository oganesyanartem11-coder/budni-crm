import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function OrdersPage() {
  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle="Все заказы по датам и статусам"
        actions={
          <>
            <button className="px-5 py-2.5 rounded-pill border border-border-strong bg-surface text-fg font-medium text-sm hover:bg-bg transition-colors">
              Распарсить из мессенджера
            </button>
            <button className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity">
              Создать заказ
            </button>
          </>
        }
      />
      <ComingSoon
        title="Заказы в разработке"
        description="Список заказов с фильтрами по дате, клиенту, статусу. Создание, подтверждение динамики, изменения до 18:00."
        sprint="Спринт 2"
      />
    </>
  )
}
