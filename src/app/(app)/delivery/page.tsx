import { PageHeader } from '@/components/layout/page-header'
import { DeliveryView } from './delivery-view'
import { requireRole } from '@/lib/auth/current-user'
import { getDeliveriesForDate } from '@/lib/db/queries/deliveries'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function DeliveryPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER', 'COURIER'])

  const params = await searchParams
  // Сегодня по МСК (Bug 7.25), UTC-детерминированно без локального setHours.
  const targetDate = params.date
    ? new Date(`${params.date}T00:00:00.000Z`)
    : getMskCalendarDayUtc(new Date(), 0)

  const stops = await getDeliveriesForDate(targetDate, { role: user.role, id: user.id })

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
