import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { getFinancialReport } from '@/lib/db/queries/reports'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import { getIngredientsConsumptionForRange } from '@/lib/db/queries/ingredients-consumption'
import { getClientsComparison } from '@/lib/db/queries/clients-comparison'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'
import { AnalyticsView } from './analytics-view'
import { MARGIN_MAX_DAYS } from './constants'

interface PageProps {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const preset = (params.preset ?? 'this_month') as ReportPreset
  const range = getPresetRange(preset, params.from, params.to)

  // totalDays — round((endMs - startMs)/day) + 1, симметрично getFinancialReport
  // и getMaterialCostForRange. После 6.6 fix getFinancialWeek границы в MSK.
  const totalDays = Math.max(
    1,
    Math.round((range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)) + 1
  )
  const showMargin = totalDays <= MARGIN_MAX_DAYS

  const [report, materialCost, ingredientsConsumption, clientsComparison] = await Promise.all([
    getFinancialReport(range.from, range.to),
    showMargin
      ? getMaterialCostForRange(range.from, range.to, REVENUE_STATUSES)
      : Promise.resolve(null),
    showMargin
      ? getIngredientsConsumptionForRange(range.from, range.to, REVENUE_STATUSES)
      : Promise.resolve(null),
    showMargin ? getClientsComparison(range.from, range.to) : Promise.resolve(null),
  ])

  // Defense-in-depth: MANAGER не видит рубли. Зануляем поля на сервере
  // ПЕРЕД отправкой в client component. Паттерн как в /ingredients для CHEF.
  const canSeePrices = user.role === 'ADMIN'

  const safeReport = canSeePrices
    ? report
    : {
        ...report,
        totalRevenue: 0,
        averageOrder: 0,
        averagePerDay: 0,
        clients: report.clients.map((c) => ({ ...c, revenue: 0 })),
        daily: report.daily.map((d) => ({ ...d, revenue: 0 })),
      }

  const safeMaterialCost = canSeePrices ? materialCost : null

  const safeIngredients =
    ingredientsConsumption === null
      ? null
      : canSeePrices
        ? ingredientsConsumption
        : {
            ...ingredientsConsumption,
            rows: ingredientsConsumption.rows.map((r) => ({
              ...r,
              pricePerUnit: 0,
              totalCost: 0,
            })),
            totalCost: 0,
          }

  const safeClients =
    clientsComparison === null
      ? null
      : canSeePrices
        ? clientsComparison
        : {
            rows: clientsComparison.rows.map((r) => ({
              ...r,
              revenue: 0,
              prevRevenue: 0,
            })),
          }

  return (
    <>
      <PageHeader
        title="Аналитика"
        subtitle={`${range.label} · ${range.from.toLocaleDateString('ru-RU')} – ${range.to.toLocaleDateString('ru-RU')}`}
      />
      <AnalyticsView
        preset={preset}
        rangeFromIso={range.from.toISOString()}
        rangeToIso={range.to.toISOString()}
        totalDays={totalDays}
        report={safeReport}
        materialCost={safeMaterialCost}
        showMargin={showMargin}
        ingredientsConsumption={safeIngredients}
        clientsComparison={safeClients}
        canSeePrices={canSeePrices}
      />
    </>
  )
}
