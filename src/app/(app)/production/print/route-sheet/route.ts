import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/current-user'
import { buildRouteSheetRows } from '@/lib/route-sheet/build-rows'
import { renderRouteSheetPdf, routeSheetFilename } from '@/lib/route-sheet/render'

// @react-pdf использует fontkit + чтение TTF с диска — нужен Node runtime
// (зеркалит UPD-роут print/upd/pdf/route.tsx).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Тот же guard, что и у соседнего print/upd-роута.
  await requireRole(['ADMIN', 'MANAGER'])

  const url = new URL(request.url)
  const dateParam = url.searchParams.get('date')
  const sameDayOnly = url.searchParams.get('sameDay') === '1'
  const disposition =
    url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'

  if (!dateParam) {
    return new NextResponse('Не указан параметр date (YYYY-MM-DD)', { status: 400 })
  }
  const m = /^(\d{4}-\d{2}-\d{2})$/.exec(dateParam)
  if (!m) {
    return new NextResponse('Неверная дата (ожидается YYYY-MM-DD)', { status: 400 })
  }

  // UTC-полночь указанной даты — совпадает с тем, как cron'ы вычисляют день МСК.
  const deliveryDate = new Date(m[1] + 'T00:00:00.000Z')

  const rows = await buildRouteSheetRows(deliveryDate, { sameDayOnly })
  const buffer = await renderRouteSheetPdf(deliveryDate, rows)
  const filename = routeSheetFilename(deliveryDate, sameDayOnly ? 'sameday' : undefined)

  // Buffer → Uint8Array для BodyInit (как в UPD-роуте).
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
