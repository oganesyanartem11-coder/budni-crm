import { PageHeader } from '@/components/layout/page-header'
import { DeliveryView } from './delivery-view'
import { requireRole } from '@/lib/auth/current-user'
import { getDeliveriesForDate } from '@/lib/db/queries/deliveries'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function DeliveryPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const params = await searchParams
  const targetDate = params.date ? new Date(params.date) : new Date()
  targetDate.setHours(0, 0, 0, 0)

  const stops = await getDeliveriesForDate(targetDate)

  return (
    <>
      <PageHeader
        title="Доставка"
        subtitle={user.role === 'COURIER' ? 'Маршрут на сегодня' : 'Сводка по доставкам'}
      />
      <DeliveryView
        stops={serialize(stops)}
        targetDateIso={targetDate.toISOString()}
        userRole={user.role}
      />
    </>
  )
}
