import { PageHeader } from '@/components/layout/page-header'
import { ReportsView } from './reports-view'
import { requireRole } from '@/lib/auth/current-user'
import { getFinancialReport } from '@/lib/db/queries/reports'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'

interface PageProps {
  searchParams: Promise<{ preset?: string; from?: string; to?: string }>
}

export default async function ReportsPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams
  const preset = (params.preset ?? 'this_month') as ReportPreset
  const range = getPresetRange(preset, params.from, params.to)
  const report = await getFinancialReport(range.from, range.to)

  return (
    <>
      <PageHeader
        title="Отчёты"
        subtitle={`${range.label} · ${range.from.toLocaleDateString('ru-RU')} – ${range.to.toLocaleDateString('ru-RU')}`}
      />
      <ReportsView
        preset={preset}
        rangeFromIso={range.from.toISOString()}
        rangeToIso={range.to.toISOString()}
        report={report}
      />
    </>
  )
}
