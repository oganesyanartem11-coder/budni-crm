import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function IngredientsPage() {
  return (
    <>
      <PageHeader
        title="Сырьё"
        subtitle="Справочник ингредиентов и цен"
      />
      <ComingSoon
        title="Сырьё в разработке"
        sprint="Спринт 1"
      />
    </>
  )
}
