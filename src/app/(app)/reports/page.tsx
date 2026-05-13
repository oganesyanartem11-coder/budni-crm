import { PageHeader } from '@/components/layout/page-header'
import { ReportsView } from './reports-view'
import { requireRole } from '@/lib/auth/current-user'
import { getFinancialReport } from '@/lib/db/queries/reports'
import { getPresetRange, type ReportPreset } from '@/lib/utils/week'

interface PageProps {
  searchParams: Promise<{ preset?: string; from?: string; to?: string; date?: string }>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default async function ReportsPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])

  const params = await searchParams

  // ?date=YYYY-MM-DD из Telegram-кнопок (production-summary, end-of-day-digest)
  // открывает отчёт за конкретный день. Невалидный формат игнорируем —
  // падаем на дефолтный preset.
  let preset: ReportPreset
  let customFrom: string | undefined
  let customTo: string | undefined
  if (params.date && DATE_RE.test(params.date)) {
    preset = 'custom'
    customFrom = params.date
    customTo = params.date
  } else {
    preset = (params.preset ?? 'this_month') as ReportPreset
    customFrom = params.from
    customTo = params.to
  }

  const range = getPresetRange(preset, customFrom, customTo)
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
