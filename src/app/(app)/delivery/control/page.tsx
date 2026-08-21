import { ManagerControlScreen } from '../_components/manager-control-screen'
import { requireRole } from '@/lib/auth/current-user'
import { getManagerDeliveryControl } from '@/lib/delivery/manager-control-read-model'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

export default async function DeliveryControlPage() {
  const user = await requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])
  const now = new Date()
  const deliveryDate = getMskCalendarDayUtc(now)
  const data = await getManagerDeliveryControl(user, deliveryDate, now)

  return <ManagerControlScreen data={data} />
}
