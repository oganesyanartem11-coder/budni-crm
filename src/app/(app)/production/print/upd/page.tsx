import Link from 'next/link'
import { ArrowLeft, AlertTriangle, CheckCircle2, FileText } from 'lucide-react'
import { previewUpdForDate } from './actions'
import { GenerateButton } from './generate-button'
import { PageHeader } from '@/components/layout/page-header'
import { requireRole } from '@/lib/auth/current-user'
import { formatDateLong, formatMoney } from '@/lib/utils/format'

interface PageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function UpdPreviewPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])
  const params = await searchParams
  const dateIso = params.date ?? (() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  })()

  const res = await previewUpdForDate(dateIso)
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto">
        <Link href="/production/print" className="inline-flex items-center gap-1.5 text-sm text-fg-muted mb-4">
          <ArrowLeft className="w-4 h-4" /> К меню печати
        </Link>
        <div className="bg-surface border border-border rounded-2xl p-6 text-danger-fg">
          {res.error}
        </div>
      </div>
    )
  }

  const { groups, unassignedOrders } = res.data
  const canGenerate = groups.length > 0
  const newGroups = groups.filter((g) => !g.alreadyGenerated)

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/production/print?date=${dateIso}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          К меню печати
        </Link>
        <GenerateButton dateIso={dateIso} disabled={!canGenerate} />
      </div>

      <PageHeader
        title="УПД"
        subtitle={`Превью документов на ${formatDateLong(new Date(dateIso))}`}
      />

      {unassignedOrders.length > 0 && (
        <div className="mb-6 rounded-2xl bg-warning-bg/30 border border-warning/30 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning-fg shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-warning-fg mb-2">
                Заказы без юрлица отгрузки — не попадут в УПД ({unassignedOrders.length})
              </h3>
              <p className="text-sm text-fg-muted mb-3">
                У этих заказов не указано наше юрлицо (поле «Отгрузка от» в карточке заказа). Назначьте юрлицо до формирования УПД.
              </p>
              <ul className="text-sm space-y-1">
                {unassignedOrders.map((o) => (
                  <li key={o.orderId} className="flex items-center gap-2">
                    <span className="text-fg-muted">·</span>
                    <Link
                      href={`/orders/${o.orderId}`}
                      className="hover:underline"
                    >
                      {o.clientName} · {o.locationName} · {o.mealLabel} · {o.portions} порц.
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="bg-surface border border-border rounded-2xl p-8 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
          На эту дату нет заказов с назначенным юрлицом отгрузки.
        </div>
      ) : (
        <div className="space-y-3">
          {newGroups.length > 0 && groups.some((g) => g.alreadyGenerated) && (
            <p className="text-sm text-fg-muted">
              Новых документов будет сформировано: <strong>{newGroups.length}</strong>. Существующие УПД будут переиспользованы (номер не меняется).
            </p>
          )}
          {groups.map((g) => (
            <div
              key={g.key}
              className="rounded-2xl bg-surface border border-border p-5"
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-semibold">{g.clientName}</h3>
                    {g.alreadyGenerated ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-success-bg text-success-fg text-xs font-medium">
                        <CheckCircle2 className="w-3 h-3" />
                        {g.existingDocumentNumber}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-info-bg text-info-fg text-xs font-medium">
                        <FileText className="w-3 h-3" />
                        Номер будет присвоен
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-fg-muted">
                    {g.locationName} · {g.locationAddress}
                  </div>
                  <div className="text-xs text-fg-subtle mt-1">
                    Отгрузка от: {g.ourLegalEntityShortName}
                  </div>
                </div>
                <div className="text-right tabular-nums">
                  <div className="font-semibold text-lg">{formatMoney(g.totalAmount, { withKopecks: true })}</div>
                  {g.vatRate && g.vatAmount && (
                    <div className="text-xs text-fg-muted">
                      в т.ч. НДС {g.vatRate}%: {formatMoney(g.vatAmount, { withKopecks: true })}
                    </div>
                  )}
                  {!g.vatRate && (
                    <div className="text-xs text-fg-muted">Без НДС</div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
                <span>Всего порций: <strong className="text-fg">{g.totalPortions}</strong></span>
                <span>·</span>
                <span>Заказов: <strong className="text-fg">{g.ordersCount}</strong></span>
                {g.meals.map((m) => (
                  <span key={m.mealType}>· {m.mealLabel}: {m.portions}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
