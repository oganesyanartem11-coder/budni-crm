import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { PrintButton } from '../../print-button'
import { UpdDocumentRender } from './upd-document-render'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from '../types'

interface PageProps {
  searchParams: Promise<{ date?: string; id?: string }>
}

export default async function UpdViewPage({ searchParams }: PageProps) {
  await requireRole(['ADMIN', 'MANAGER'])
  const params = await searchParams

  // Режим выбирается по параметру: id — один документ для перепечати,
  // date — все УПД отгрузки на эту дату.
  const docs = await (async () => {
    if (params.id) {
      const d = await prisma.updDocument.findUnique({ where: { id: params.id } })
      return d ? [d] : []
    }
    if (params.date) {
      // UpdDocument.deliveryDate — @db.Date (UTC midnight в БД). Границы строим
      // в UTC, чтобы локальная TZ сервера не сдвигала окно.
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(params.date)
      if (!m) return []
      const ymd = m[1]
      const from = new Date(ymd + 'T00:00:00.000Z')
      const end = new Date(ymd + 'T23:59:59.999Z')
      if (Number.isNaN(from.getTime()) || Number.isNaN(end.getTime())) return []
      return prisma.updDocument.findMany({
        where: { deliveryDate: { gte: from, lte: end } },
        orderBy: [{ documentNumber: 'asc' }],
      })
    }
    return []
  })()

  const backHref = params.id
    ? '/production/print/upd/list'
    : `/production/print/upd?date=${params.date ?? ''}`
  const backLabel = params.id ? 'К списку выписанных УПД' : 'К превью'

  return (
    <>
      {/* Scoped @page: landscape только когда смонтирован этот route (UPD print-view).
          В globals.css @page не трогаем — иначе сломаем книжную у kitchen/courier. */}
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } }`}</style>
      <div className="no-print mb-6 flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {backLabel}
        </Link>
        <PrintButton />
      </div>

      <div className="print-area max-w-4xl mx-auto">
        {docs.length === 0 ? (
          <div className="bg-surface border border-border rounded-2xl p-8 text-center text-fg-muted" style={{ boxShadow: 'var(--shadow-card)' }}>
            Документ не найден.
          </div>
        ) : (
          docs.flatMap((d) => {
            const supplier = d.supplierSnapshot as unknown as UpdSupplierSnapshot
            const buyer = d.buyerSnapshot as unknown as UpdBuyerSnapshot
            const lines = d.linesSnapshot as unknown as UpdLineSnapshot[]
            const docData = {
              documentNumber: d.documentNumber,
              deliveryDate: d.deliveryDate,
              totalAmount: d.totalAmount.toFixed(2),
              vatAmount: d.vatAmount ? d.vatAmount.toFixed(2) : null,
              vatRate: d.vatRate ? d.vatRate.toFixed(2) : null,
              amountWithoutVat: d.amountWithoutVat.toFixed(2),
              supplier, buyer, lines,
            }
            return [
              <UpdDocumentRender
                key={`${d.id}-1`}
                doc={docData}
                copyLabel="Экземпляр 1 (для продавца, возвращается подписанным)"
              />,
              <UpdDocumentRender
                key={`${d.id}-2`}
                doc={docData}
                copyLabel="Экземпляр 2 (для покупателя)"
              />,
            ]
          })
        )}
      </div>
    </>
  )
}
