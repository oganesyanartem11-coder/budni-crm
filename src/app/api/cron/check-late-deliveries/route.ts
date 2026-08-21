import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { evaluateDeliveryLate } from '@/lib/delivery/delivery-late'
import { ensureCourierRouteStopsForDate } from '@/lib/delivery/route-materializer'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
import { formatDeliveryWindow } from '@/lib/utils/format'
import { getTelegramEnv } from '@/lib/telegram/env'
import { escapeHtml, notifyGroup } from '@/lib/telegram/notify'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ACTION = 'LATE_DELIVERY_ALERTS_SENT'
export const LATE_ALERT_CLAIM_STALE_MINUTES = 15

const LATE_ALERT_STOP_SELECT = {
  id: true,
  deliveryDate: true,
  assignmentMode: true,
  clientNameSnapshot: true,
  locationNameSnapshot: true,
  deliveryWindowFromSnapshot: true,
  deliveryWindowToSnapshot: true,
  routeDay: { select: { courierNameSnapshot: true } },
} satisfies Prisma.CourierRouteStopSelect

type LateAlertStop = Prisma.CourierRouteStopGetPayload<{
  select: typeof LATE_ALERT_STOP_SELECT
}>

interface LateAlertError {
  stopId: string
  reason: string
}

function assigneeLabel(stop: LateAlertStop): string {
  if (stop.routeDay) return stop.routeDay.courierNameSnapshot
  return stop.assignmentMode === 'EXTERNAL' ? 'InDrive' : 'Не назначен'
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildLateDeliveryAlertText(
  stop: LateAlertStop,
  now: Date,
  controlUrl: string,
): string {
  const late = evaluateDeliveryLate(
    stop.deliveryDate,
    stop.deliveryWindowToSnapshot,
    now,
  )
  const delayMinutes = Math.floor(late.delayMinutes ?? 0)
  const window = formatDeliveryWindow(
    stop.deliveryWindowFromSnapshot,
    stop.deliveryWindowToSnapshot,
  )

  return [
    '⚠️ <b>Опоздание доставки</b>',
    '',
    `🚚 Курьер: ${escapeHtml(assigneeLabel(stop))}`,
    `🏢 Клиент: ${escapeHtml(stop.clientNameSnapshot)}`,
    `📍 Точка: ${escapeHtml(stop.locationNameSnapshot)}`,
    `🕐 Окно: ${escapeHtml(window || 'не указано')}`,
    `⏱ Задержка: ${delayMinutes} мин`,
    `🔗 <a href="${escapeHtmlAttribute(controlUrl)}">Открыть контроль доставки</a>`,
  ].join('\n')
}

export async function handler(_request: Request): Promise<NextResponse> {
  const now = new Date()
  const deliveryDate = getMskCalendarDayUtc(now)

  if (process.env.DELIVERY_LATE_ALERTS_ENABLED === 'false') {
    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: 'LATE_DELIVERY_ALERTS_SKIPPED_FLAG',
        entityType: 'System',
        entityId: deliveryDate.toISOString().slice(0, 10),
        payload: { skipped: true, reason: 'flag' },
      },
    })
    return NextResponse.json({ ok: true, skipped: true, reason: 'flag' })
  }

  await ensureCourierRouteStopsForDate(deliveryDate, now)

  const staleBefore = new Date(
    now.getTime() - LATE_ALERT_CLAIM_STALE_MINUTES * 60_000,
  )
  const claimable: Prisma.CourierRouteStopWhereInput[] = [
    { lateAlertClaimedAt: null },
    { lateAlertClaimedAt: { lt: staleBefore } },
  ]
  const candidates = await prisma.courierRouteStop.findMany({
    where: {
      deliveryDate,
      deliveredAt: null,
      cancelledAt: null,
      deliveryWindowToSnapshot: { not: null },
      lateAlertSentAt: null,
      OR: claimable,
    },
    select: LATE_ALERT_STOP_SELECT,
    orderBy: [
      { deliveryWindowToSnapshot: 'asc' },
      { id: 'asc' },
    ],
  })

  const errors: LateAlertError[] = []
  let sent = 0
  let controlUrl: string | null = null

  for (const stop of candidates) {
    const late = evaluateDeliveryLate(
      stop.deliveryDate,
      stop.deliveryWindowToSnapshot,
      now,
    )
    if (!late.isLate) continue
    controlUrl ??= `${getTelegramEnv().appBaseUrl}/delivery/control`

    const claimed = await prisma.courierRouteStop.updateMany({
      where: {
        id: stop.id,
        deliveredAt: null,
        cancelledAt: null,
        deliveryWindowToSnapshot: { not: null },
        lateAlertSentAt: null,
        OR: claimable,
      },
      data: { lateAlertClaimedAt: now },
    })
    if (claimed.count !== 1) continue

    let notification: { ok: boolean; error?: string }
    try {
      notification = await notifyGroup(
        buildLateDeliveryAlertText(stop, now, controlUrl),
        { parseMode: 'HTML' },
      )
    } catch (error) {
      notification = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }

    if (!notification.ok) {
      await prisma.courierRouteStop.updateMany({
        where: {
          id: stop.id,
          lateAlertSentAt: null,
          lateAlertClaimedAt: now,
        },
        data: { lateAlertClaimedAt: null },
      })
      errors.push({
        stopId: stop.id,
        reason: notification.error ?? 'telegram_unknown_error',
      })
      continue
    }

    const marked = await prisma.courierRouteStop.updateMany({
      where: {
        id: stop.id,
        lateAlertSentAt: null,
        lateAlertClaimedAt: now,
      },
      data: {
        lateAlertClaimedAt: null,
        lateAlertSentAt: now,
      },
    })
    if (marked.count === 1) {
      sent += 1
    } else {
      errors.push({ stopId: stop.id, reason: 'sent_marker_conflict' })
    }
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: deliveryDate.toISOString().slice(0, 10),
      payload: {
        sent,
        errors: errors.length,
        details: errors.map((error) => ({
          stopId: error.stopId,
          reason: error.reason,
        })),
      },
    },
  })

  return NextResponse.json(
    { ok: errors.length === 0, sent, errors },
    { status: errors.length === 0 ? 200 : 502 },
  )
}

export const GET = withCronHeartbeat('check-late-deliveries', handler)
