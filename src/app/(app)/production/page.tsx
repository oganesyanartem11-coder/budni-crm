import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function ProductionPage() {
  return (
    <>
      <PageHeader
        title="Производство"
        subtitle="Что готовим завтра — сводно и по клиентам"
      />
      <ComingSoon
        title="Производство в разработке"
        description="Сводная таблица блюд и сырья, разбивка по клиентам, печатные формы."
        sprint="Спринт 3"
      />
    </>
  )
}
