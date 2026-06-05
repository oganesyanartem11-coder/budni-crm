import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { buildRouteSheetRows } from '@/lib/route-sheet/build-rows'
import {
  renderRouteSheetPdf,
  routeSheetFilename,
  formatRouteSheetDate,
} from '@/lib/route-sheet/render'
import { sendRouteSheetToProduction } from '@/lib/route-sheet/send'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

/**
 * П2: утренний same-day маршрутный лист на СЕГОДНЯ (07:50 МСК).
 *
 * Только локации с sameDayDelivery=true и заказы в статусе CONFIRMED
 * (см. buildRouteSheetRows({ sameDayOnly:true })). Идемпотентность —
 * Order.routeSheetSentAt.
 */
async function handler(_request: Request) {
  const now = new Date()
  const today = mskMidnightUtc(now, 0)
  const todayIso = today.toISOString().slice(0, 10)

  const rows = await buildRouteSheetRows(today, { sameDayOnly: true })
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'empty', date: todayIso })
  }

  const orderIds = rows.map((r) => r.orderId)

  const unsent = await prisma.order.count({
    where: { id: { in: orderIds }, routeSheetSentAt: null },
  })
  if (unsent === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_sent', date: todayIso })
  }

  const buffer = await renderRouteSheetPdf(today, rows)
  const dateLabel = formatRouteSheetDate(today)
  const totalPortions = rows.reduce((s, r) => s + r.portions, 0)
  const caption =
    `🌅 Маршрутный лист (same-day) на сегодня, ${dateLabel}\n` +
    `${rows.length} заказов, ${totalPortions} порций`

  await sendRouteSheetToProduction({
    pdfBuffer: buffer,
    filename: routeSheetFilename(today, 'sameday'),
    caption,
  })

  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: { routeSheetSentAt: new Date() },
  })

  return NextResponse.json({
    ok: true,
    date: todayIso,
    orders: rows.length,
    portions: totalPortions,
    sent: true,
  })
}

export const GET = withCronHeartbeat('route-sheet-sameday', handler)
