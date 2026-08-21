import { notFound } from 'next/navigation'
import { ManagerRouteDetailScreen } from '../../_components/manager-route-detail-screen'
import { requireRole } from '@/lib/auth/current-user'
import { getManagerCourierRouteDetail } from '@/lib/delivery/manager-control-read-model'

interface PageProps {
  params: Promise<{ routeDayId: string }>
  searchParams: Promise<{ stop?: string }>
}

export default async function ManagerCourierRoutePage({ params, searchParams }: PageProps) {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])
  const [{ routeDayId }, query] = await Promise.all([params, searchParams])
  const data = await getManagerCourierRouteDetail(user, routeDayId, query.stop ?? null)

  if (!data) notFound()

  return <ManagerRouteDetailScreen data={data} />
}
