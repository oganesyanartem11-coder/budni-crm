import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Дашборд"
        subtitle="Главная сводка: офис и цех"
        actions={
          <button className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity">
            Создать заказ
          </button>
        }
      />
      <ComingSoon
        title="Дашборд в разработке"
        description="Здесь будут метрики выручки, ключевые показатели офиса и цеха, аномалии и AI-инсайты."
        sprint="Спринт 4"
      />
    </>
  )
}
