import Link from 'next/link'
import { Printer } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ProductionView } from './production-view'
import { requireRole } from '@/lib/auth/current-user'
import { getProductionSummary, getIngredientsSummary } from '@/lib/db/queries/production'
import { formatDateShort } from '@/lib/utils/format'

interface PageProps {
  searchParams: Promise<{ date?: string; tab?: string }>
}

export default async function ProductionPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'CHEF', 'MANAGER'])

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

  const isDefaultTomorrow = targetDate.getTime() === defaultDate.getTime()
  const dateLabel = isDefaultTomorrow
    ? `Завтра, ${formatDateShort(targetDate)}`
    : formatDateShort(targetDate)

  const canSeePrices = user.role !== 'CHEF'

  // Defense-in-depth: для CHEF зануляем финансовые поля. UI всё равно их скрывает.
  const safeSummary = canSeePrices
    ? summary
    : {
        ...summary,
        totalRevenue: 0,
        mealTypes: {
          BREAKFAST: { ...summary.mealTypes.BREAKFAST, totalRevenue: 0 },
          LUNCH: { ...summary.mealTypes.LUNCH, totalRevenue: 0 },
          DINNER: { ...summary.mealTypes.DINNER, totalRevenue: 0 },
        },
      }
  const safeIngredientsSummary = canSeePrices
    ? ingredientsSummary
    : {
        ...ingredientsSummary,
        totalCost: 0,
        totalRevenue: 0,
        estimatedMargin: 0,
        rows: ingredientsSummary.rows.map((r) => ({
          ...r,
          pricePerUnit: 0,
          totalCost: 0,
        })),
      }

  return (
    <>
      <PageHeader
        title="Производство"
        subtitle={dateLabel}
        actions={
          <Link
            href={`/production/print?date=${targetDate.toISOString().slice(0, 10)}`}
            style={{ touchAction: 'manipulation' }}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-brand-green-light px-4 text-sm font-medium text-brand-green-deep transition-colors hover:bg-brand-green-light/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            Печать
          </Link>
        }
      />
      <ProductionView
        summary={safeSummary}
        ingredientsSummary={safeIngredientsSummary}
        targetDateIso={targetDate.toISOString()}
        tab={tab}
        canSeePrices={canSeePrices}
      />
    </>
  )
}
