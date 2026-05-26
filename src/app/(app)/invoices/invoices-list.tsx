import Link from 'next/link'
import { ReceiptText, ChevronRight, Sparkles, Search as SearchIcon } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { InvoiceStatusChip } from '@/lib/invoices/status-chip'
import { formatDateLong, pluralize } from '@/lib/utils/format'
import { formatMoneyRu } from '@/lib/digest/format'
import { SearchBar } from './search-bar'
import type { InvoiceStatus } from '@prisma/client'

interface InvoiceRow {
  id: string
  supplierName: string
  invoiceNumber: string
  // serialize() оставляет Date как есть — RSC сериализует штатно;
  // принимаем оба формата, чтобы page.tsx не требовал ручного toISOString().
  invoiceDate: Date | string
  receivedAt: Date | string
  status: InvoiceStatus
  totalAmount: number | null
  _count: { lines: number }
}

const STATUS_FILTERS: Array<{ key: 'all' | InvoiceStatus; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'AWAITING_ACCEPT', label: 'Ожидают' },
  { key: 'ACCEPTED', label: 'Принятые' },
  { key: 'PROCESSING', label: 'В обработке' },
  { key: 'FAILED', label: 'Ошибки' },
  { key: 'REJECTED', label: 'Отклонённые' },
  { key: 'REVERTED', label: 'Откаченные' },
]

function buildHref(
  key: 'all' | InvoiceStatus,
  supplier?: string,
  q?: string
): string {
  const sp = new URLSearchParams()
  if (key !== 'all') sp.set('status', key)
  if (supplier) sp.set('supplier', supplier)
  if (q) sp.set('q', q)
  const qs = sp.toString()
  return qs ? `/invoices?${qs}` : '/invoices'
}

export function InvoicesList({
  invoices,
  activeStatus,
  activeSupplier,
  activeQuery,
  draftIngredientsCount,
}: {
  invoices: InvoiceRow[]
  activeStatus: InvoiceStatus | undefined
  activeSupplier: string | undefined
  activeQuery: string | undefined
  draftIngredientsCount: number
}) {
  const hasActiveFilters = Boolean(activeStatus || activeSupplier || activeQuery)

  return (
    <div className="space-y-4">
      {draftIngredientsCount > 0 && (
        <Link
          href="/invoices/draft-ingredients"
          className="block rounded-2xl border border-info/30 bg-info/5 p-4 hover:bg-info/10 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-info-fg shrink-0" />
              <div>
                <p className="font-medium text-fg">
                  🆕 {draftIngredientsCount}{' '}
                  {pluralize(draftIngredientsCount, [
                    'новый ингредиент',
                    'новых ингредиента',
                    'новых ингредиентов',
                  ])}{' '}
                  ждут утверждения
                </p>
                <p className="text-sm text-fg-muted">
                  Проверьте и утвердите или объедините с существующими
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-fg-subtle shrink-0" />
          </div>
        </Link>
      )}

      <SearchBar initial={activeQuery} />

      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((f) => {
          const isActive = f.key === 'all' ? !activeStatus : activeStatus === f.key
          return (
            <Link
              key={f.key}
              href={buildHref(f.key, activeSupplier, activeQuery)}
              className={`px-3 py-1.5 rounded-pill text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-accent text-accent-fg'
                  : 'bg-bg text-fg-muted hover:text-fg hover:bg-border'
              }`}
            >
              {f.label}
            </Link>
          )
        })}
      </div>

      {invoices.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={SearchIcon}
            title="Не найдено накладных по фильтрам"
            description="Попробуйте изменить фильтры или поисковый запрос."
            cta={
              <Link
                href="/invoices"
                className="px-5 py-2.5 rounded-pill border border-border text-fg font-medium text-sm hover:bg-fg/5 transition-colors inline-flex items-center gap-2"
              >
                Сбросить фильтры
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={ReceiptText}
            title="📦 Пока ни одной накладной"
            description="Сфотографируйте накладную — AI распознает позиции и сопоставит с базой ингредиентов."
            cta={
              <Link
                href="/invoices/new"
                className="px-5 py-2.5 rounded-pill bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity inline-flex items-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                Загрузить накладную
              </Link>
            }
          />
        )
      ) : (
        <div className="space-y-2">
          {invoices.map((inv) => (
            <Link
              key={inv.id}
              href={`/invoices/${inv.id}`}
              className="block bg-surface border border-border rounded-2xl p-4 hover:border-fg/20 transition-colors"
              style={{ boxShadow: 'var(--shadow-card)' }}
            >
              <div className="flex items-center gap-4">
                <ReceiptText className="w-6 h-6 text-fg-subtle shrink-0" strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <p className="font-medium text-fg truncate">{inv.supplierName}</p>
                    <span className="text-xs text-fg-subtle truncate">№ {inv.invoiceNumber}</span>
                  </div>
                  <p className="text-sm text-fg-muted">
                    {formatDateLong(inv.invoiceDate)}
                    {inv._count.lines > 0 && ` · ${inv._count.lines} позиций`}
                  </p>
                </div>
                {inv.totalAmount !== null && (
                  <p className="text-sm font-semibold text-fg tabular-nums whitespace-nowrap hidden sm:block">
                    {formatMoneyRu(inv.totalAmount)}
                  </p>
                )}
                <InvoiceStatusChip status={inv.status} className="shrink-0" />
                <ChevronRight className="w-4 h-4 text-fg-subtle shrink-0" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
