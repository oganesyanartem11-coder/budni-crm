import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/current-user'
import {
  CourierRouteReadAccessError,
  getOwnCourierRouteDay,
  getOwnCourierRouteStop,
} from '@/lib/delivery/courier-route-read-model'
import { ensureCourierRouteStopsForDate } from '@/lib/delivery/route-materializer'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { CourierStopScreen } from '../../_components/courier-stop-screen'

interface PageProps {
  params: Promise<{ stopId: string }>
}

export default async function CourierStopPage({ params }: PageProps) {
  const actor = await requireRole(['COURIER'])
  const { stopId } = await params
  const now = new Date()
  const today = getMskCalendarDayUtc(now)
  await ensureCourierRouteStopsForDate(today, now)

  let stop
  try {
    stop = await getOwnCourierRouteStop(actor, stopId, now)
  } catch (error) {
    if (error instanceof CourierRouteReadAccessError) notFound()
    throw error
  }

  const route = await getOwnCourierRouteDay(actor, stop.deliveryDate, now)
  if (!route) notFound()

  const openStops = [route.nextStop, ...route.otherStops]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  const currentIndex = openStops.findIndex((item) => item.id === stop.id)
  const nextStopId = stop.deliveredAt
    ? openStops.find((item) => item.id !== stop.id)?.id ?? null
    : currentIndex >= 0
      ? openStops[currentIndex + 1]?.id ?? null
      : openStops[0]?.id ?? null

  return (
    <CourierStopScreen
      stop={stop}
      nextStopId={nextStopId}
      routeProgress={{
        delivered: route.deliveredStops,
        total: route.totalStops,
        remaining: route.remainingStops,
      }}
    />
  )
}
