import { PageHeader } from '@/components/layout/page-header'
import { ComingSoon } from '@/components/layout/coming-soon'

export default function MenuPage() {
  return (
    <>
      <PageHeader
        title="Меню и техкарты"
        subtitle="Недельный цикл, блюда, рецепты"
      />
      <ComingSoon
        title="Меню в разработке"
        sprint="Спринт 1"
      />
    </>
  )
}
