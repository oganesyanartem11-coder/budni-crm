import { PageHeader } from '@/components/layout/page-header'
import { ProductionView } from './production-view'
import { requireRole } from '@/lib/auth/current-user'
import { getProductionSummary, getIngredientsSummary } from '@/lib/db/queries/production'

interface PageProps {
  searchParams: Promise<{ date?: string; tab?: string }>
}

export default async function ProductionPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

  const params = await searchParams

  // Default дата — завтра
  const defaultDate = (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(0, 0, 0, 0)
    return d
  })()

  const targetDate = params.date ? new Date(params.date) : defaultDate
  targetDate.setHours(0, 0, 0, 0)

  const [summary, ingredientsSummary] = await Promise.all([
    getProductionSummary(targetDate),
    getIngredientsSummary(targetDate),
  ])
  const tab: 'dishes' | 'ingredients' = params.tab === 'ingredients' ? 'ingredients' : 'dishes'

  return (
    <>
      <PageHeader
        title="Производство"
        subtitle="Сводка для кухни — что и сколько готовить"
      />
      <ProductionView
        summary={summary}
        ingredientsSummary={ingredientsSummary}
        targetDateIso={targetDate.toISOString()}
        tab={tab}
      />
    </>
  )
}
