import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function AnalyticsPage() {
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
