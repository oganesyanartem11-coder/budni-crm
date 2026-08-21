import { NextResponse } from 'next/server'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import {
  acquireMultipartDeliveryClaim,
  completeMultipartDeliveryClaim,
  failMultipartDeliveryClaim,
  markMultipartDeliveryPartSent,
  resumeMultipartDeliveryClaim,
} from '@/lib/cron/multipart-delivery-claim'
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Детерминированная вечерняя сводка назначения курьеров на завтра по МСК. */
export async function handler(_request: Request): Promise<NextResponse> {
  const now = new Date()
  if (await alreadyRanToday(JOB_NAME, now)) {
    return NextResponse.json({ ok: true, skipped: 'already_ran_today' })
  }

  const deliveryDate = getMskCalendarDayUtc(now, 1)
  const deliveryDateString = toMskDateString(deliveryDate)
  const claimKey = `${JOB_NAME}:${deliveryDateString}`
  const orders = await getCourierAssignmentOrders(deliveryDate)
  const groups = groupCourierAssignments(orders)
  const messages = orders.length > 0
    ? formatCourierAssignmentMessages(groups, deliveryDate)
    : []
  const claimResult = orders.length > 0
    ? await acquireMultipartDeliveryClaim(claimKey, messages)
    : await resumeMultipartDeliveryClaim(claimKey)
  if (claimResult.status === 'no_claim') {
    return NextResponse.json({ ok: true, skipped: 'no_orders' })
  }
  if (claimResult.status === 'in_progress') {
    return NextResponse.json({ ok: true, skipped: 'delivery_in_progress' })
  }
  if (claimResult.status === 'already_sent') {
    return NextResponse.json({ ok: true, skipped: 'already_delivered' })
  }

  let claim = claimResult
  try {
    for (
      let partIndex = claim.nextPartIndex;
      partIndex < claim.messages.length;
      partIndex += 1
    ) {
      const sent = await notifyProductionChannel(claim.messages[partIndex], {
        parseMode: 'HTML',
      })
      if (!sent.ok) {
        throw new Error(`Courier assignment Telegram failure: ${sent.error}`)
      }
      claim = await markMultipartDeliveryPartSent(claim, partIndex)
    }

    await completeMultipartDeliveryClaim(claim)
  } catch (error) {
    try {
      await failMultipartDeliveryClaim(claim, errorMessage(error))
    } catch (claimError) {
      console.error(`[cron:${JOB_NAME}] failed to persist delivery failure`, claimError)
    }
    throw error
  }

  const couriers = groups.filter((group) => group.assignedCourier !== null).length
  const stops = groups.reduce((sum, group) => sum + group.stops.length, 0)
  const unassigned = groups
    .filter((group) => group.assignmentMode === 'UNASSIGNED')
    .reduce((sum, group) => sum + group.stops.length, 0)
  const payload = {
    deliveryDate: deliveryDateString,
    couriers,
    stops,
    orders: orders.length,
    unassigned,
    messages: claim.messages.length,
  }

  // Setting claim — источник истины для доставки. ActivityLog остаётся только
  // операционным следом и не должен превращать уже доставленную сводку в retry.
  try {
    await markRanToday(JOB_NAME, payload)
  } catch (error) {
    console.error(`[cron:${JOB_NAME}] failed to persist ActivityLog`, error)
  }

  console.log(`[cron:${JOB_NAME}] success`, payload)
  return NextResponse.json({ ok: true, ...payload })
}

export const GET = withCronHeartbeat(JOB_NAME, handler)
