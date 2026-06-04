import { NextResponse } from 'next/server'
import { notifyProductionChannel, escapeHtml } from '@/lib/telegram/notify'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  getOrdersForHourBeforeWindow,
  markCourierNotified,
  type OrderWithoutCourier,
} from '@/lib/orders/courier-queries'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * П5: «за час до окна» (vercel.json "*\/30 2-8 * * *" UTC = 05:00–11:30 МСК
 * каждые 30 мин). Ловит заказы на СЕГОДНЯ без курьера, чьё окно начинается
 * примерно через час (см. getOrdersForHourBeforeWindow: [now+50м, now+90м]).
 *
 * ИНДИВИДУАЛЬНЫЙ пуш на каждый заказ (срочное напоминание). markCourierNotified
 * вызывается ПО ОДНОМУ сразу после успешного пуша конкретного заказа: так при
 * частичном сбое (упал TG на 3-м из 5) уже отправленные не задублируются на
 * следующем запуске через 30 мин, а неотправленные останутся в выборке.
 */
export async function handler(_request: Request): Promise<NextResponse> {
  const now = new Date()
  const orders = await getOrdersForHourBeforeWindow(now)
  if (orders.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  let sent = 0
  for (const order of orders) {
    // notifyProductionChannel не кидает (внутри фолбэк). Если всё же бросит на
    // одном заказе — пробрасываем дальше: уже помеченные не задублируются,
    // текущий и оставшиеся подхватит следующий запуск.
    await notifyProductionChannel(buildHourBeforeText(order), { parseMode: 'HTML' })
    await markCourierNotified([order.orderId])
    sent += 1
  }

  return NextResponse.json({ ok: true, sent })
}

/** HTML-текст одиночного срочного напоминания по заказу. */
export function buildHourBeforeText(order: OrderWithoutCourier): string {
  const windowLine =
    order.deliveryWindowFrom && order.deliveryWindowTo
      ? `${order.deliveryWindowFrom}-${order.deliveryWindowTo}`
      : 'не указано'
  const contact = order.clientContactPhone ? escapeHtml(order.clientContactPhone) : 'не указан'
  return (
    `⚠️ Через час доставка — курьер не назначен:\n\n` +
    `${escapeHtml(order.clientName)} (${escapeHtml(order.locationName)})\n` +
    `Окно: ${windowLine}\n` +
    `Адрес: ${escapeHtml(order.locationAddress)}\n` +
    `Контакт: ${contact}\n` +
    `Объём: ${order.portions} порций`
  )
}

export const GET = withCronHeartbeat('courier-hour-before-window', handler)
