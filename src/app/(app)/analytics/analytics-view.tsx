'use client'

import { useState } from 'react'
import { PeriodSelector } from '@/components/period-selector'
import { ChartCard } from '@/components/charts/chart-card'
import { RevenueLineChart } from '@/components/charts/revenue-line-chart'
import { formatMoneyRu } from '@/lib/digest/format'
import { cn } from '@/lib/utils/cn'
import type { ReportPreset } from '@/lib/utils/week'
import type { FinancialReport, DailyPoint } from '@/lib/db/queries/reports'
import type { MaterialCostResult } from '@/lib/digest/material-cost'

// Граница для расчёта маржи: до квартала включительно. Дальше getMaterialCostForRange
// делает N+1 запросов (per-day MenuCycle.findFirst), на годовом периоде это 365+
// запросов. Когда оптимизируем aggregate — порог можно поднять.
export const MARGIN_MAX_DAYS = 92

type Metric = 'revenue' | 'portions'

interface Props {
  preset: ReportPreset
  rangeFromIso: string
  rangeToIso: string
  totalDays: number
  report: FinancialReport
  materialCost: MaterialCostResult | null
  showMargin: boolean
}

const MONTH_RU_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

const DAILY_MODE_MAX = 31

export function AnalyticsView({
  preset,
  rangeFromIso,
  rangeToIso,
  totalDays,
  report,
  materialCost,
  showMargin,
}: Props) {
  const [metric, setMetric] = useState<Metric>('revenue')

  const dailyMode = totalDays <= DAILY_MODE_MAX

  const chartData = dailyMode
    ? report.daily.map((d) => ({
        label: d.label,
        value: metric === 'revenue' ? d.revenue : d.portions,
      }))
    : aggregateMonthly(report.daily, metric)

  // Маржа: считаем только если есть materialCost и хоть один день с меню.
  // Иначе margin == revenue (cost=0), что обманчиво.
  const hasMenuInPeriod =
    materialCost !== null &&
    materialCost.totalDays > 0 &&
    materialCost.daysWithoutMenu < materialCost.totalDays

  const margin = hasMenuInPeriod && materialCost ? report.totalRevenue - materialCost.totalCost : null
  const marginPct =
    margin !== null && report.totalRevenue > 0
      ? Math.round((margin / report.totalRevenue) * 100)
      : null

  return (
    <div className="space-y-6">
      <div
        className="rounded-2xl bg-surface border border-border p-4"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <PeriodSelector
          preset={preset}
          rangeFromIso={rangeFromIso}
          rangeToIso={rangeToIso}
          basePath="/analytics"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Выручка" value={formatMoneyRu(report.totalRevenue)} />
        <MetricCard
          label="Заказов"
          value={String(report.totalOrders)}
          hint={`${report.totalPortions.toLocaleString('ru-RU')} порций`}
        />
        <MetricCard label="Средний чек" value={formatMoneyRu(report.averageOrder)} />
        <MetricCard label="В день в среднем" value={formatMoneyRu(report.averagePerDay)} />
      </div>

      {showMargin && materialCost ? (
        hasMenuInPeriod ? (
          <div className="grid grid-cols-2 gap-3">
            <MetricCard
              label="Себестоимость"
              value={formatMoneyRu(materialCost.totalCost)}
              hint={
                materialCost.daysWithoutMenu > 0
                  ? `без учёта ${materialCost.daysWithoutMenu} из ${materialCost.totalDays} дн. без меню`
                  : undefined
              }
            />
            <MetricCard
              label="Маржа"
              value={
                margin !== null && marginPct !== null
                  ? `${formatMoneyRu(margin)} (${marginPct}%)`
                  : margin !== null
                    ? formatMoneyRu(margin)
                    : '—'
              }
            />
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            Меню не утверждено ни на один день периода — маржу посчитать не из чего.
          </p>
        )
      ) : (
        <p className="text-xs text-fg-muted">
          Маржа доступна для периодов до квартала ({MARGIN_MAX_DAYS} дн.). Сейчас выбрано {totalDays} дн.
        </p>
      )}

      <ChartCard
        title="Динамика"
        subtitle={dailyMode ? 'По дням' : 'По месяцам (агрегация)'}
        height="md"
        action={
          <div className="inline-flex rounded-pill border border-border p-0.5 bg-bg text-xs">
            <MetricToggle active={metric === 'revenue'} onClick={() => setMetric('revenue')}>
              Выручка
            </MetricToggle>
            <MetricToggle active={metric === 'portions'} onClick={() => setMetric('portions')}>
              Порции
            </MetricToggle>
          </div>
        }
      >
        <RevenueLineChart
          data={chartData}
          formatValue={
            metric === 'revenue'
              ? formatMoneyRu
              : (v) => `${v.toLocaleString('ru-RU')} порций`
          }
        />
      </ChartCard>
    </div>
  )
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="rounded-2xl border border-border bg-surface p-4"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="text-lg font-semibold text-fg tabular-nums mt-1">{value}</p>
      {hint && <p className="text-xs text-fg-subtle mt-0.5">{hint}</p>}
    </div>
  )
}

function MetricToggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded-pill transition-colors',
        active ? 'bg-accent text-accent-fg font-medium' : 'text-fg-muted hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

/**
 * Группирует daily-точки в monthly-агрегат по 'YYYY-MM' (slice от DailyPoint.date).
 * Сортировка по ключу — лексикографическая, что для ISO-дат эквивалентно
 * хронологической.
 */
function aggregateMonthly(daily: DailyPoint[], metric: Metric): Array<{ label: string; value: number }> {
  const byMonth = new Map<string, number>()
  for (const d of daily) {
    const ym = d.date.slice(0, 7) // 'YYYY-MM'
    const inc = metric === 'revenue' ? d.revenue : d.portions
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + inc)
  }
  return Array.from(byMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ym, value]) => {
      const [year, month] = ym.split('-')
      return {
        label: `${MONTH_RU_SHORT[Number(month) - 1]} ${year.slice(2)}`,
        value,
      }
    })
}
