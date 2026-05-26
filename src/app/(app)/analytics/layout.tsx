import { getCurrentUser } from '@/lib/auth/current-user'
import { isAdminPro } from '@/lib/auth/role-helpers'
import { AnalyticsTabs } from './analytics-tabs'

/**
 * Layout раздела «Аналитика»: общая шапка с табами.
 * Role-guard не здесь — каждая page делает свой requireRole
 * (/analytics — ADMIN+MANAGER, /analytics/cost — только ADMIN,
 *  /analytics/invoices — строго ADMIN_PRO).
 *
 * Таб «Приёмки» виден ТОЛЬКО ADMIN_PRO, чтобы не показывать не-PRO «битый» переход.
 */
export default async function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()

  const tabs: Array<{ href: string; label: string }> = [
    { href: '/analytics', label: 'Общая' },
    { href: '/analytics/cost', label: 'Себестоимость' },
  ]
  if (isAdminPro(user.role)) {
    tabs.push({ href: '/analytics/invoices', label: 'Приёмки' })
  }

  return (
    <div className="space-y-5">
      <AnalyticsTabs tabs={tabs} />
      <div>{children}</div>
    </div>
  )
}
