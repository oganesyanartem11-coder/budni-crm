import Link from 'next/link'
import { ReceiptText, ChevronRight, Sparkles } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { InvoiceStatusChip } from '@/lib/invoices/status-chip'
import { formatDateLong } from '@/lib/utils/format'
import { formatMoneyRu } from '@/lib/digest/format'
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

function buildHref(key: 'all' | InvoiceStatus, supplier?: string): string {
  const sp = new URLSearchParams()
  if (key !== 'all') sp.set('status', key)
  if (supplier) sp.set('supplier', supplier)
  const qs = sp.toString()
  return qs ? `/invoices?${qs}` : '/invoices'
}

export function InvoicesList({
  invoices,
  activeStatus,
  activeSupplier,
}: {
  invoices: InvoiceRow[]
  activeStatus: InvoiceStatus | undefined
  activeSupplier: string | undefined
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((f) => {
          const isActive = f.key === 'all' ? !activeStatus : activeStatus === f.key
          return (
            <Link
              key={f.key}
              href={buildHref(f.key, activeSupplier)}
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
        <EmptyState
          icon={ReceiptText}
          title="Накладных пока нет"
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
