'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Wheat, Users, ChevronRight } from 'lucide-react'
import { PeriodSelector } from '@/components/period-selector'
import { ChartCard } from '@/components/charts/chart-card'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { RevenueLineChart } from '@/components/charts/revenue-line-chart'
import { formatMoneyRu } from '@/lib/digest/format'
import { cn } from '@/lib/utils/cn'
import { MARGIN_MAX_DAYS, DAILY_MODE_MAX } from './constants'
import type { ReportPreset } from '@/lib/utils/week'
import type { FinancialReport, DailyPoint } from '@/lib/db/queries/reports'
import type { MaterialCostResult } from '@/lib/digest/material-cost'
import type { IngredientsConsumptionResult } from '@/lib/db/queries/ingredients-consumption'
import type { ClientsComparisonResult } from '@/lib/db/queries/clients-comparison'

type Metric = 'revenue' | 'portions'

type MetricTone = 'revenue' | 'orders' | 'amount' | 'margin'

const METRIC_TONE_CLASSES: Record<MetricTone, { bg: string; ink: string }> = {
  revenue: { bg: 'bg-data-revenue-bg', ink: 'text-data-revenue-ink' },
  orders: { bg: 'bg-data-orders-bg', ink: 'text-data-orders-ink' },
  amount: { bg: 'bg-data-amount-bg', ink: 'text-data-amount-ink' },
  margin: { bg: 'bg-data-margin-bg', ink: 'text-data-margin-ink' },
}

interface Props {
  preset: ReportPreset
  rangeFromIso: string
  rangeToIso: string
  totalDays: number
  report: FinancialReport
  materialCost: MaterialCostResult | null
  showMargin: boolean
  ingredientsConsumption: IngredientsConsumptionResult | null
  clientsComparison: ClientsComparisonResult | null
  canSeePrices: boolean
}

const MONTH_RU_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

export function AnalyticsView({
  preset,
  rangeFromIso,
  rangeToIso,
  totalDays,
  report,
  materialCost,
  showMargin,
  ingredientsConsumption,
  clientsComparison,
  canSeePrices,
}: Props) {
  // MANAGER график выручки не видит → форсим 'portions' как стартовое значение
  // и прячем toggle. Server-side daily.revenue уже занулен (defense-in-depth).
  const [metric, setMetric] = useState<Metric>(canSeePrices ? 'revenue' : 'portions')

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

  const margin =
    hasMenuInPeriod && materialCost ? report.totalRevenue - materialCost.totalCost : null
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

      {/* Hero metrics. MANAGER видит только «Заказов» (без рублей).
          ADMIN видит все 4. */}
      <div
        className={cn(
          'grid gap-3',
          canSeePrices ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1 md:grid-cols-2'
        )}
      >
        {canSeePrices && (
          <MetricCard label="Выручка" value={formatMoneyRu(report.totalRevenue)} tone="revenue" />
        )}
        <MetricCard
          label="Заказов"
          value={String(report.totalOrders)}
          hint={`${report.totalPortions.toLocaleString('ru-RU')} порций`}
          tone="orders"
        />
        {canSeePrices && (
          <>
            <MetricCard label="Средний чек" value={formatMoneyRu(report.averageOrder)} tone="amount" />
            <MetricCard label="В день в среднем" value={formatMoneyRu(report.averagePerDay)} tone="amount" />
          </>
        )}
      </div>

      {/* Блок маржи — только для ADMIN. MANAGER не видит ни цифр, ни fallback'а. */}
      {canSeePrices &&
        (showMargin && materialCost ? (
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
                tone="amount"
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
                tone="margin"
              />
            </div>
          ) : (
            <p className="text-xs text-fg-muted">
              Меню не утверждено ни на один день периода — маржу посчитать не из чего.
            </p>
          )
        ) : (
          <p className="text-xs text-fg-muted">
            Маржа доступна для периодов до квартала ({MARGIN_MAX_DAYS} дн.). Сейчас выбрано{' '}
            {totalDays} дн.
          </p>
        ))}

      <ChartCard
        title="Динамика"
        subtitle={dailyMode ? 'По дням' : 'По месяцам (агрегация)'}
        height="md"
        action={
          canSeePrices ? (
            <SegmentedControl
              size="sm"
              value={metric}
              onChange={(v) => setMetric(v as Metric)}
              options={[
                { value: 'revenue', label: 'Выручка' },
                { value: 'portions', label: 'Порции' },
              ]}
            />
          ) : undefined
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

      {/* Расход сырья за период (топ-15). При totalDays > 92 — null, блок не рендерится. */}
      {ingredientsConsumption && ingredientsConsumption.rows.length > 0 && (
        <div
          className="rounded-2xl bg-surface border border-border p-5"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Wheat className="w-4 h-4 text-fg-muted" />
            <h3 className="text-base font-semibold">
              Расход сырья ({ingredientsConsumption.rows.length})
            </h3>
          </div>
          <ul className="divide-y divide-border">
            {ingredientsConsumption.rows.slice(0, 15).map((r, i) => (
              <li key={r.ingredientId} className="flex items-center gap-3 py-2.5 px-2">
                <div className="w-7 h-7 rounded-full bg-bg flex items-center justify-center text-xs font-bold text-fg-muted shrink-0">
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate text-sm">{r.ingredientName}</p>
                  <p className="text-xs text-fg-muted">{formatNeeded(r.totalNeeded, r.unit)}</p>
                </div>
                {canSeePrices && (
                  <p className="font-semibold tabular-nums whitespace-nowrap text-sm">
                    {formatMoneyRu(r.totalCost)}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {ingredientsConsumption.rows.length > 15 && (
            <p className="text-xs text-fg-subtle mt-3 text-center">
              Показаны первые 15 из {ingredientsConsumption.rows.length}
            </p>
          )}
        </div>
      )}

      {/* Клиенты периода с динамикой (топ-10). При totalDays > 92 — null. */}
      {clientsComparison && clientsComparison.rows.length > 0 && (
        <div
          className="rounded-2xl bg-surface border border-border p-5"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-fg-muted" />
            <h3 className="text-base font-semibold">
              Клиенты периода ({clientsComparison.rows.length})
            </h3>
          </div>
          <ul className="divide-y divide-border">
            {clientsComparison.rows.slice(0, 10).map((c, i) => (
              <li key={c.clientId}>
                <Link
                  href={`/clients/${c.clientId}`}
                  className="flex items-center gap-3 py-2.5 px-2 rounded-xl hover:bg-bg/50 transition-colors group"
                >
                  <div className="w-7 h-7 rounded-full bg-bg flex items-center justify-center text-xs font-bold text-fg-muted shrink-0">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate text-sm">{c.clientName}</p>
                    <p className="text-xs text-fg-muted">
                      {c.ordersCount} зак. · {c.portions} порц.
                      {c.isNew && ' · новый'}
                      {!c.isNew && c.growthPct !== null && ` · ${formatGrowth(c.growthPct)}`}
                    </p>
                  </div>
                  {canSeePrices && (
                    <p className="font-semibold tabular-nums whitespace-nowrap text-sm">
                      {formatMoneyRu(c.revenue)}
                    </p>
                  )}
                  <ChevronRight className="w-3.5 h-3.5 text-fg-subtle group-hover:text-fg-muted transition-colors" />
                </Link>
              </li>
            ))}
          </ul>
          {clientsComparison.rows.length > 10 && (
            <p className="text-xs text-fg-subtle mt-3 text-center">
              Показаны первые 10 из {clientsComparison.rows.length}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone: MetricTone
}) {
  const t = METRIC_TONE_CLASSES[tone]
  return (
    <div className={cn('rounded-2xl p-5', t.bg)}>
      <p className={cn('text-[11px] font-bold uppercase tracking-widest', t.ink)}>{label}</p>
      <p className="mt-1.5 font-display text-xl font-bold tabular-nums text-fg-strong">{value}</p>
      {hint && <p className="text-xs text-fg-muted mt-0.5">{hint}</p>}
    </div>
  )
}

function formatNeeded(value: number, unit: 'KG' | 'L' | 'PCS'): string {
  const label = unit === 'KG' ? 'кг' : unit === 'L' ? 'л' : 'шт'
  if (unit === 'PCS') return `${Math.round(value).toLocaleString('ru-RU')} ${label}`
  // кг/л — одна цифра после запятой, ru-локаль через запятую
  return `${value.toFixed(1).replace('.', ',')} ${label}`
}

function formatGrowth(pct: number): string {
  if (Math.abs(pct) < 1) return 'на уровне'
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

/**
 * Группирует daily-точки в monthly-агрегат по 'YYYY-MM' (slice от DailyPoint.date).
 * Сортировка по ключу — лексикографическая, что для ISO-дат эквивалентно
 * хронологической.
 */
function aggregateMonthly(daily: DailyPoint[], metric: Metric): Array<{ label: string; value: number }> {
  const byMonth = new Map<string, number>()
  for (const d of daily) {
    const ym = d.date.slice(0, 7)
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
