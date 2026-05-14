import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'
import { requireRole } from '@/lib/auth/current-user'

export default async function AnalyticsPage() {
  await requireRole(['ADMIN'])

  return (
    <>
      <PageHeader
        title="Аналитика"
        subtitle="Финансовая неделя пт–пт, тренды, AI-инсайты"
      />
      <ComingSoon
        title="Аналитика в разработке"
        sprint="В планах после пилота"
      />
    </>
  )
}
