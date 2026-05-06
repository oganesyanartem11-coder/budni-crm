import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function DeliveryPage() {
  return (
    <>
      <PageHeader
        title="Доставка"
        subtitle="Курьеры, маршруты, статусы"
      />
      <ComingSoon
        title="Доставка в разработке"
        sprint="Спринт 4"
      />
    </>
  )
}
