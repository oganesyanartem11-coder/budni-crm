import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { UpdPdfDocument, type UpdPdfDocData } from './upd-pdf-document'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from '../types'

// @react-pdf использует fontkit + чтение TTF с диска — нужен Node runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // requireRole в роут-хэндлере работает так же, как в page: внутри getSession()
  // используется cookies() из next/headers, который доступен в обоих контекстах.
  await requireRole(['ADMIN', 'MANAGER'])

  const url = new URL(request.url)
  const idParam = url.searchParams.get('id')
  const dateParam = url.searchParams.get('date')

  let dateYmd: string | null = null

  let docs: Awaited<ReturnType<typeof prisma.updDocument.findMany>> = []
  if (idParam) {
    const d = await prisma.updDocument.findUnique({ where: { id: idParam } })
    if (d) docs = [d]
  } else if (dateParam) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(dateParam)
    if (!m) {
      return new NextResponse('Неверная дата', { status: 400 })
    }
    dateYmd = m[1]
    const from = new Date(dateYmd + 'T00:00:00.000Z')
    const to = new Date(dateYmd + 'T23:59:59.999Z')
    docs = await prisma.updDocument.findMany({
      where: { deliveryDate: { gte: from, lte: to } },
      orderBy: [{ documentNumber: 'asc' }],
    })
  } else {
    return new NextResponse('Не указан параметр date или id', { status: 400 })
  }

  if (docs.length === 0) {
    return new NextResponse('УПД не найдены', { status: 404 })
  }

  const docData: UpdPdfDocData[] = docs.map((d) => ({
    documentNumber: d.documentNumber,
    deliveryDate: d.deliveryDate,
    totalAmount: d.totalAmount.toFixed(2),
    vatAmount: d.vatAmount ? d.vatAmount.toFixed(2) : null,
    vatRate: d.vatRate ? d.vatRate.toFixed(2) : null,
    amountWithoutVat: d.amountWithoutVat.toFixed(2),
    supplier: d.supplierSnapshot as unknown as UpdSupplierSnapshot,
    buyer: d.buyerSnapshot as unknown as UpdBuyerSnapshot,
    lines: d.linesSnapshot as unknown as UpdLineSnapshot[],
  }))

  const buffer = await renderToBuffer(<UpdPdfDocument docs={docData} />)

  // Имя файла: ASCII-safe (documentNumber вида "УПД-2026-0001" заменяем UPD-).
  // Для пакетного режима по дате — берём дату.
  const filename = (() => {
    if (docs.length === 1) {
      const d = docs[0]
      // documentNumber: "УПД-2026-0001" → "UPD-2026-0001"
      return `${d.documentNumber.replace(/^УПД/, 'UPD')}.pdf`
    }
    return `UPD-${dateYmd ?? 'batch'}.pdf`
  })()

  // Buffer (Node) приводим к Uint8Array для типа BodyInit — это валидный
  // конструктор NextResponse и стабильный API на Vercel Node runtime.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
