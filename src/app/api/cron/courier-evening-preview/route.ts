import { NextResponse } from 'next/server'
import { notifyProductionChannel, escapeHtml } from '@/lib/telegram/notify'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  getOrdersWithoutCourierTomorrow,
  markCourierNotified,
  type OrderWithoutCourier,
} from '@/lib/orders/courier-queries'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * П5: вечерний обзор (18:00 МСК = vercel.json "0 15 * * *" UTC).
 *
 * Один свод в чат-производство по всем ЗАВТРАШНИМ заказам без назначенного
 * курьера, по которым ещё не уведомляли. Цель — заранее заказать курьеров.
 *
 * Антидубль: markCourierNotified вызывается ТОЛЬКО после успешной отправки.
 * notifyProductionChannel по контракту не кидает (внутри фолбэк в личку
 * ADMIN_PRO), но если бросит — пометка не ставится и заказы попадут в
 * следующий запуск (при "0 15 * * *" он один в сутки).
 */
export async function handler(_request: Request): Promise<NextResponse> {
  const orders = await getOrdersWithoutCourierTomorrow()
  if (orders.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  const text = buildEveningPreviewText(orders)

  // markCourierNotified — строго ПОСЛЕ отправки. Если notifyProductionChannel
  // бросит, исключение пробьётся в withCronHeartbeat (heartbeat + trackError),
  // а пометка не проставится → заказы остаются «не уведомлёнными».
  await notifyProductionChannel(text, { parseMode: 'HTML' })
  await markCourierNotified(orders.map((o) => o.orderId))

  return NextResponse.json({ ok: true, sent: orders.length })
}

/**
 * HTML-текст вечернего обзора. Сортировка: по deliveryWindowFrom ASC,
 * заказы без окна («не указано») — в конце.
 */
export function buildEveningPreviewText(orders: OrderWithoutCourier[]): string {
  const sorted = [...orders].sort(compareByWindowFrom)

  let text = `📦 Курьеров на завтра: ${sorted.length} заказов. Закажите через InDrive\n\n`
  sorted.forEach((o, i) => {
    const windowLine =
      o.deliveryWindowFrom && o.deliveryWindowTo
        ? `${o.deliveryWindowFrom}-${o.deliveryWindowTo}`
        : 'не указано'
    const phoneLine = o.clientContactPhone
      ? `<code>${escapeHtml(o.clientContactPhone)}</code>`
      : 'не указан'
    text +=
      `${i + 1}. <b>${escapeHtml(o.locationName)}</b> (${escapeHtml(o.clientName)})\n` +
      `Окно: ${windowLine}\n` +
      `Адрес: <code>${escapeHtml(o.locationAddress)}</code>\n` +
      `Телефон: ${phoneLine}\n` +
      `Объём: ${o.portions} порций (${o.totalPrice} ₽)\n\n`
  })
  return text.trimEnd()
}

/** null/пустое окно сортируется в конец списка. */
function compareByWindowFrom(a: OrderWithoutCourier, b: OrderWithoutCourier): number {
  const fa = a.deliveryWindowFrom
  const fb = b.deliveryWindowFrom
  if (fa === fb) return 0
  if (!fa) return 1
  if (!fb) return -1
  return fa < fb ? -1 : 1
}

export const GET = withCronHeartbeat('courier-evening-preview', handler)
