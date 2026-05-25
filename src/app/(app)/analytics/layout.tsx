import { AnalyticsTabs } from './analytics-tabs'

const TABS = [
  { href: '/analytics', label: 'Общая' },
  { href: '/analytics/cost', label: 'Себестоимость' },
]

/**
 * Layout раздела «Аналитика»: общая шапка с табами.
 * Role-guard не здесь — каждая page делает свой requireRole
 * (/analytics — ADMIN+MANAGER, /analytics/cost — только ADMIN).
 */
export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <AnalyticsTabs tabs={TABS} />
      <div>{children}</div>
    </div>
  )
}
