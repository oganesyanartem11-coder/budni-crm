import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import { computeUnconfirmedConfigs } from '@/lib/boris/production-summary-format'
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
 * П2: вечерний маршрутный лист на ЗАВТРА (16:10 МСК).
 *
 * Пропускаем, если есть «не ответившие» DYNAMIC-конфиги (логика 1:1 с
 * production-summary, но БЕЗ редактирования того cron'а): пока не все клиенты
 * подтвердили — лист на завтра неполон, не шлём.
 *
 * Идемпотентность — Order.routeSheetSentAt: если все заказы листа уже помечены,
 * повторный заход (Vercel retry) ничего не шлёт.
 */
async function handler(_request: Request) {
  const now = new Date()
  const tomorrow = mskMidnightUtc(now, 1)
  const tomorrowIso = tomorrow.toISOString().slice(0, 10)

  // --- «Не ответили» (реплика production-summary без редактирования cron'а) ---
  const tomorrowEnd = new Date(tomorrow)
  tomorrowEnd.setUTCHours(23, 59, 59, 999)
  const ordersForUnconfirmed = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: tomorrow, lte: tomorrowEnd },
      status: { notIn: ['CANCELLED'] },
    },
    select: { clientId: true, locationId: true, mealType: true, status: true },
  })
  const dynamicConfigs = await prisma.clientMealConfig.findMany({
    where: {
      isActive: true,
      orderType: 'DYNAMIC',
      client: { isActive: true },
      location: { isActive: true },
    },
    include: {
      client: { select: { name: true } },
      location: { select: { name: true } },
    },
  })
  const activeConfigsForTomorrow = dynamicConfigs.filter((c) => isScheduledForDate(c, tomorrow))
  const unconfirmedConfigs = computeUnconfirmedConfigs(activeConfigsForTomorrow, ordersForUnconfirmed)

  if (unconfirmedConfigs.length > 0) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'unconfirmed_exist',
      date: tomorrowIso,
      unconfirmed: unconfirmedConfigs.length,
    })
  }

  // --- Строки листа ---
  const rows = await buildRouteSheetRows(tomorrow)
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'empty', date: tomorrowIso })
  }

  const orderIds = rows.map((r) => r.orderId)

  // Идемпотентность: если ВСЕ заказы листа уже помечены — лист уже отправлен.
  const unsent = await prisma.order.count({
    where: { id: { in: orderIds }, routeSheetSentAt: null },
  })
  if (unsent === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_sent', date: tomorrowIso })
  }

  const buffer = await renderRouteSheetPdf(tomorrow, rows)
  const dateLabel = formatRouteSheetDate(tomorrow)
  const totalPortions = rows.reduce((s, r) => s + r.portions, 0)
  const caption =
    `🚚 Маршрутный лист на завтра, ${dateLabel}\n` +
    `${rows.length} заказов, ${totalPortions} порций`

  await sendRouteSheetToProduction({
    pdfBuffer: buffer,
    filename: routeSheetFilename(tomorrow),
    caption,
  })

  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: { routeSheetSentAt: new Date() },
  })

  return NextResponse.json({
    ok: true,
    date: tomorrowIso,
    orders: rows.length,
    portions: totalPortions,
    sent: true,
  })
}

export const GET = withCronHeartbeat('route-sheet-evening', handler)
