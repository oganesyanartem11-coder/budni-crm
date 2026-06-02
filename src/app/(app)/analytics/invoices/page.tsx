import Link from 'next/link'
import { ReceiptText } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ChartCard } from '@/components/charts/chart-card'
import { requireRole } from '@/lib/auth/current-user'
import {
  resolvePeriod,
  getTopSuppliers,
  getTopPriceGrowth,
  getHiddenMarginLoss,
  getGroupPriceTrend,
  countAcceptedInvoicesInRange,
} from '@/lib/db/queries/invoice-analytics'
import { PeriodSelector, type Period } from '@/components/analytics/PeriodSelector'
import { SupplierTopChart } from '@/components/analytics/invoices/SupplierTopChart'
import { PriceGrowthChart } from '@/components/analytics/invoices/PriceGrowthChart'
import { MarginLossWidget } from '@/components/analytics/invoices/MarginLossWidget'
import { GroupPriceTrendChart } from '@/components/analytics/invoices/GroupPriceTrendChart'

interface PageProps {
  searchParams: Promise<{ period?: string }>
}

/**
 * /analytics/invoices — аналитика приёмок. Строго ADMIN_PRO
 * (без 'ADMIN' в массиве — иначе обычные ADMIN-ы тоже получат доступ).
 */
export default async function InvoicesAnalyticsPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN_PRO'])

  const params = await searchParams
  const resolved = resolvePeriod(params.period)
  const { from, to, period, label } = resolved

  const acceptedCount = await countAcceptedInvoicesInRange({ from, to })

  // Empty state: < 2 ACCEPTED накладных за период.
  if (acceptedCount < 2) {
    return (
      <>
        <PageHeader
          title="Аналитика приёмок"
          subtitle={label}
          actions={<PeriodSelector activePeriod={period as Period} basePath="/analytics/invoices" />}
        />
        <div
          className="rounded-2xl bg-surface border border-border p-8 text-center"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-fg/5 mb-3">
            <ReceiptText className="w-6 h-6 text-fg-muted" />
          </div>
          <h3 className="text-base font-semibold text-fg">Данных пока недостаточно</h3>
          <p className="text-sm text-fg-muted mt-1 max-w-md mx-auto">
            Принимайте поставки через{' '}
            <Link href="/invoices/new" className="text-accent-fg hover:underline font-medium">
              /invoices/new
            </Link>
            . Когда за период будет принято хотя бы 2 поставки, появятся графики.
          </p>
          <p className="text-xs text-fg-subtle mt-3">
            За «{label.toLowerCase()}» принято: {acceptedCount}
          </p>
        </div>
      </>
    )
  }

  // Параллельные запросы — критично для нагрузки на DB.
  const [suppliers, priceGrowth, marginLoss, trendKg, trendL, trendPcs] = await Promise.all([
    getTopSuppliers({ from, to }),
    getTopPriceGrowth({ from, to }),
    getHiddenMarginLoss({ from, to }),
    getGroupPriceTrend({ from, to, group: 'KG' }),
    getGroupPriceTrend({ from, to, group: 'L' }),
    getGroupPriceTrend({ from, to, group: 'PCS' }),
  ])

  return (
    <>
      <PageHeader
        title="Аналитика приёмок"
        subtitle={label}
        actions={<PeriodSelector activePeriod={period as Period} basePath="/analytics/invoices" />}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* W1: Top-10 поставщиков */}
        <ChartCard
          title="Top-10 поставщиков по объёму"
          subtitle="Сумма принятых поставок за период"
          height="lg"
        >
          <SupplierTopChart data={suppliers} />
        </ChartCard>

        {/* W2: Top-10 ингредиентов по росту цены */}
        <ChartCard
          title="Top-10 ингредиентов по росту цены"
          subtitle="Самые свежие изменения за период, сортировка по росту"
          height="lg"
          bodyClassName="overflow-y-auto"
        >
          <PriceGrowthChart data={priceGrowth} />
        </ChartCard>

        {/* W3: Скрытая потеря маржи */}
        <ChartCard
          title="Скрытая потеря маржи"
          subtitle="Разница между средней и минимальной ценой за период"
          height="lg"
        >
          <MarginLossWidget data={marginLoss} />
        </ChartCard>

        {/* W4: динамика по группам (KG/L/PCS) */}
        <GroupPriceTrendChart initial={{ KG: trendKg, L: trendL, PCS: trendPcs }} />
      </div>
    </>
  )
}
