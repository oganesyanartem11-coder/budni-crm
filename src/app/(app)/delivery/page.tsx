import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { DeliveryView } from './delivery-view'
import { CourierRouteScreen } from './_components/courier-route-screen'
import { requireRole } from '@/lib/auth/current-user'
import { getDeliveriesForDate } from '@/lib/db/queries/deliveries'
import { getOwnCourierRouteDay } from '@/lib/delivery/courier-route-read-model'
import { ensureCourierRouteStopsForDate } from '@/lib/delivery/route-materializer'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { serialize } from '@/lib/utils/serialize'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function DeliveryPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER', 'COURIER'])
  const now = new Date()

  if (user.role === 'COURIER') {
    const today = getMskCalendarDayUtc(now, 0)
    await ensureCourierRouteStopsForDate(today, now)
    const route = await getOwnCourierRouteDay(user, today, now)
    return <CourierRouteScreen route={route} />
  }

  const params = await searchParams
  // Сегодня по МСК (Bug 7.25), UTC-детерминированно без локального setHours.
  const targetDate = params.date
    ? new Date(`${params.date}T00:00:00.000Z`)
    : getMskCalendarDayUtc(now, 0)

  const stops = await getDeliveriesForDate(targetDate, { role: user.role, id: user.id })

  return (
    <>
      <PageHeader
        title="Доставка"
        subtitle="Сводка по доставкам"
        actions={(
          <Link href="/delivery/control" className="inline-flex min-h-11 items-center rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-capsule)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2">
            Контроль доставки
          </Link>
        )}
      />
      <DeliveryView
        stops={serialize(stops)}
        targetDateIso={targetDate.toISOString()}
        userRole={user.role}
      />
    </>
  )
}
