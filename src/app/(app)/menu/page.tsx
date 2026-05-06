import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'
import { requireRole } from '@/lib/auth/current-user'

export default async function MenuPage() {
  await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  return (
    <>
      <PageHeader
        title="Меню"
        subtitle="Недельный план питания"
      />
      <ComingSoon
        title="Меню в разработке"
        description="Просмотр и редактирование недельного меню. Утверждение шефом и админом."
        sprint="Промт 1.3"
      />
    </>
  )
}
