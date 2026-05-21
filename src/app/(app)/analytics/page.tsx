import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { getFinancialReport } from '@/lib/db/queries/reports'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'
import { AnalyticsView, MARGIN_MAX_DAYS } from './analytics-view'

interface PageProps {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>
}

export default async function AnalyticsPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN'])

  const params = await searchParams
  const preset = (params.preset ?? 'this_month') as ReportPreset
  const range = getPresetRange(preset, params.from, params.to)

  // totalDays вычисляется ТОЙ ЖЕ арифметикой что в getFinancialReport и
  // getMaterialCostForRange — round((endMs - startMs)/day) + 1 — чтобы при
  // showMargin=true totalDays здесь сходился с materialCost.totalDays.
  const totalDays = Math.max(
    1,
    Math.round((range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)) + 1
  )
  const showMargin = totalDays <= MARGIN_MAX_DAYS

  const [report, materialCost] = await Promise.all([
    getFinancialReport(range.from, range.to),
    showMargin
      ? getMaterialCostForRange(range.from, range.to, REVENUE_STATUSES)
      : Promise.resolve(null),
  ])

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
        report={report}
        materialCost={materialCost}
        showMargin={showMargin}
      />
    </>
  )
}
