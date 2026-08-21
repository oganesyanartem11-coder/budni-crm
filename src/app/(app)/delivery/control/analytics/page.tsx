import { ManagerAnalyticsScreen } from '../../_components/manager-analytics-screen'
import { requireRole } from '@/lib/auth/current-user'
import {
  resolveDeliveryAnalyticsPeriod,
  type DeliveryAnalyticsPeriodInput,
} from '@/lib/delivery/delivery-analytics'
import { getManagerDeliveryAnalytics } from '@/lib/delivery/manager-control-read-model'

interface PageProps {
  searchParams: Promise<DeliveryAnalyticsPeriodInput>
}

export default async function DeliveryAnalyticsPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])
  const period = resolveDeliveryAnalyticsPeriod(await searchParams)
  const analytics = await getManagerDeliveryAnalytics(user, period)

  return <ManagerAnalyticsScreen analytics={analytics} period={period} />
}
