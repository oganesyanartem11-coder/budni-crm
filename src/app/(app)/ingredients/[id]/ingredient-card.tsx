'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/layout/page-header'
import { ChartCard } from '@/components/charts/chart-card'
import { RevenueLineChart } from '@/components/charts/revenue-line-chart'
import { formatMoney, formatDateLong, formatDateShort } from '@/lib/utils/format'
import type { Serialized } from '@/lib/utils/serialize'
import type { Ingredient, IngredientPriceHistory } from '@prisma/client'

const UNIT_LABELS: Record<Ingredient['unit'], string> = {
  KG: 'кг',
  L: 'л',
  PCS: 'шт',
}

const JOURNAL_LIMIT = 20

type SerializedIngredient = Serialized<Ingredient & { priceHistory: IngredientPriceHistory[] }>

interface Props {
  ingredient: SerializedIngredient
  canSeePrices: boolean
}

export function IngredientCard({ ingredient, canSeePrices }: Props) {
  const history = ingredient.priceHistory
  const unitLabel = UNIT_LABELS[ingredient.unit]

  return (
    <>
      <div className="mb-6">
        <Link
          href="/ingredients"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Все ингредиенты
        </Link>
      </div>
      <PageHeader
        title={ingredient.name}
        subtitle={ingredient.isActive ? 'Карточка ингредиента' : 'В архиве'}
      />

      <div className="space-y-5">
        <section
          className="rounded-2xl bg-surface border border-border p-5"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <h3 className="text-base font-semibold mb-4">Основное</h3>
          <dl className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-fg-muted mb-1">Единица измерения</dt>
              <dd className="font-medium">{unitLabel}</dd>
            </div>
            {canSeePrices && (
              <div>
                <dt className="text-xs text-fg-muted mb-1">Текущая цена</dt>
                <dd className="font-medium tabular-nums">
                  {formatMoney(ingredient.pricePerUnit)} / {unitLabel}
                </dd>
              </div>
            )}
            {ingredient.notes && (
              <div className="md:col-span-3">
                <dt className="text-xs text-fg-muted mb-1">Заметки</dt>
                <dd className="text-fg whitespace-pre-wrap">{ingredient.notes}</dd>
              </div>
            )}
          </dl>
        </section>

        {canSeePrices && <PriceHistorySection history={history} unitLabel={unitLabel} />}

        {canSeePrices && history.length >= 1 && (
          <PriceJournal history={history} unitLabel={unitLabel} />
        )}
      </div>
    </>
  )
}

function PriceHistorySection({
  history,
  unitLabel,
}: {
  history: SerializedIngredient['priceHistory']
  unitLabel: string
}) {
  if (history.length === 0) {
    return (
      <section
        className="rounded-2xl bg-surface border border-border p-5"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <h3 className="text-base font-semibold mb-2">История цены</h3>
        <p className="text-sm text-fg-muted">История отсутствует</p>
      </section>
    )
  }

  if (history.length === 1) {
    const only = history[0]
    return (
      <section
        className="rounded-2xl bg-surface border border-border p-5"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <h3 className="text-base font-semibold mb-2">История цены</h3>
        <p className="text-sm text-fg-muted">
          Цена не менялась — {formatMoney(only.price)} / {unitLabel} с{' '}
          {formatDateLong(only.validFrom)}
        </p>
      </section>
    )
  }

  const chronological = history.toReversed()
  const data = chronological.map((h) => ({
    label: formatDateShort(h.validFrom),
    value: Number(h.price),
  }))

  return (
    <ChartCard title="История цены" subtitle="по записям изменения" height="md">
      <RevenueLineChart
        data={data}
        formatValue={(v) => `${formatMoney(v)} / ${unitLabel}`}
      />
    </ChartCard>
  )
}

function PriceJournal({
  history,
  unitLabel,
}: {
  history: SerializedIngredient['priceHistory']
  unitLabel: string
}) {
  const visible = history.slice(0, JOURNAL_LIMIT)
  const overflow = Math.max(0, history.length - JOURNAL_LIMIT)

  return (
    <section
      className="rounded-2xl bg-surface border border-border p-5"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <h3 className="text-base font-semibold mb-4">Журнал изменений</h3>
      <ul className="space-y-1.5">
        {visible.map((h) => (
          <li
            key={h.id}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-bg/40 text-sm"
          >
            <span className="text-fg-muted">{formatDateLong(h.validFrom)}</span>
            <span className="font-medium tabular-nums">
              {formatMoney(h.price)} / {unitLabel}
            </span>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <p className="text-xs text-fg-subtle mt-3">Ещё {overflow} записей</p>
      )}
    </section>
  )
}
