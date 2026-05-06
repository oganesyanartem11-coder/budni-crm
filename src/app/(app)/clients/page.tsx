import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function ClientsPage() {
  return (
    <>
      <PageHeader
        title="Клиенты"
        subtitle="Карточки клиентов, точки, расписания, цены"
        actions={
          <button className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity">
            Добавить клиента
          </button>
        }
      />
      <ComingSoon
        title="Клиенты в разработке"
        sprint="Спринт 1"
      />
    </>
  )
}
