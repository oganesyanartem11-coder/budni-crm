import { NextResponse } from 'next/server'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import {
  formatCourierAssignmentMessages,
  groupCourierAssignments,
} from '@/lib/orders/courier-assignment-summary'
import { getCourierAssignmentOrders } from '@/lib/orders/courier-queries'
import { notifyProductionChannel } from '@/lib/telegram/notify'
import { getMskCalendarDayUtc, toMskDateString } from '@/lib/utils/msk-window'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_NAME = 'courier-assignment-summary'

/** Детерминированная вечерняя сводка назначения курьеров на завтра по МСК. */
export async function handler(_request: Request): Promise<NextResponse> {
  const now = new Date()
  if (await alreadyRanToday(JOB_NAME, now)) {
    return NextResponse.json({ ok: true, skipped: 'already_ran_today' })
  }

  const deliveryDate = getMskCalendarDayUtc(now, 1)
  const orders = await getCourierAssignmentOrders(deliveryDate)
  if (orders.length === 0) {
    return NextResponse.json({ ok: true, skipped: 'no_orders' })
  }

  const groups = groupCourierAssignments(orders)
  const messages = formatCourierAssignmentMessages(groups, deliveryDate)
  for (const message of messages) {
    const sent = await notifyProductionChannel(message, { parseMode: 'HTML' })
    if (!sent.ok) {
      throw new Error(`Courier assignment Telegram failure: ${sent.error}`)
    }
  }

  const deliveryDateString = toMskDateString(deliveryDate)
  const couriers = groups.filter((group) => group.assignedCourier !== null).length
  const stops = groups.reduce((sum, group) => sum + group.stops.length, 0)
  const unassigned = orders.filter((order) => order.assignedCourier === null).length
  const payload = {
    deliveryDate: deliveryDateString,
    couriers,
    stops,
    orders: orders.length,
    unassigned,
    messages: messages.length,
  }

  // Marker ставится только после полной доставки всех частей. Проверка следом
  // превращает best-effort ошибку ActivityLog в честный cron failure.
  await markRanToday(JOB_NAME, payload)
  if (!(await alreadyRanToday(JOB_NAME, now))) {
    throw new Error('Courier assignment idempotency marker was not persisted')
  }

  console.log(`[cron:${JOB_NAME}] success`, payload)
  return NextResponse.json({ ok: true, ...payload })
}

export const GET = withCronHeartbeat(JOB_NAME, handler)
