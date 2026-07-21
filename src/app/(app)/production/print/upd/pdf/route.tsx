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
  const clientIdParam = url.searchParams.get('clientId')
  const disposition =
    url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'

  let dateYmd: string | null = null

  // Границы календарного дня строго по UTC — ТЕМ ЖЕ способом, что и ветка ?date=
  // (UpdDocument.deliveryDate = @db.Date, Prisma отдаёт UTC midnight). Единый
  // хелпер для веток ?date= и ?clientId=&date=, чтобы не было off-by-one.
  const parseDay = (raw: string): { ymd: string; from: Date; to: Date } | null => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
    if (!m) return null
    const ymd = m[1]
    return {
      ymd,
      from: new Date(ymd + 'T00:00:00.000Z'),
      to: new Date(ymd + 'T23:59:59.999Z'),
    }
  }

  let docs: Awaited<ReturnType<typeof prisma.updDocument.findMany>> = []
  if (idParam) {
    const d = await prisma.updDocument.findUnique({ where: { id: idParam } })
    if (d) docs = [d]
  } else if (clientIdParam && dateParam) {
    // Печать всех УПД одного клиента за выбранный день (вход из раздела Заказы).
    const day = parseDay(dateParam)
    if (!day) {
      return new NextResponse('Неверная дата', { status: 400 })
    }
    dateYmd = day.ymd
    docs = await prisma.updDocument.findMany({
      where: {
        clientId: clientIdParam,
        deliveryDate: { gte: day.from, lte: day.to },
      },
      orderBy: [{ documentNumber: 'asc' }],
    })
    if (docs.length === 0) {
      // Читаемый ответ, НЕ 400/404: у клиента может просто не быть УПД за день.
      return new NextResponse(
        'За выбранный день у клиента нет выпущенных УПД. Сформируйте их в разделе Печать → УПД.',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    }
  } else if (dateParam) {
    const day = parseDay(dateParam)
    if (!day) {
      return new NextResponse('Неверная дата', { status: 400 })
    }
    dateYmd = day.ymd
    docs = await prisma.updDocument.findMany({
      where: { deliveryDate: { gte: day.from, lte: day.to } },
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
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
