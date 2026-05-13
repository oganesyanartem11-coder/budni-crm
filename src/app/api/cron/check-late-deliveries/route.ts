import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { formatPortions } from '@/lib/utils/format'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ACTION = 'LATE_DELIVERY_ALERTS_SENT'
const LATE_THRESHOLD_MIN = 30
const MSK_OFFSET_HOURS = 3

/**
 * 6.4: каждые 10 мин (vercel.json `*\/10 6-19 * * *` UTC = 09:00–22:00 МСК)
 * ищет заказы на сегодня, у которых:
 *   - status ∈ {CONFIRMED, LOCKED, IN_PRODUCTION, OUT_FOR_DELIVERY}
 *   - location.deliveryWindowTo задано
 *   - сейчас > windowTo + 30 мин (опаздывает)
 *   - lateAlertSentAt IS NULL (антидубль)
 * Группирует по client+location (одна остановка → одно сообщение в Telegram),
 * шлёт в групповой чат, ставит lateAlertSentAt=now() всем участвующим Order.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const todayMsk = mskMidnightUtc(now, 0)

  const candidates = await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: { in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'] },
      lateAlertSentAt: null,
    },
    select: {
      id: true,
      portions: true,
      clientId: true,
      locationId: true,
      client: { select: { name: true } },
      location: { select: { name: true, deliveryWindowTo: true } },
    },
  })

  // Группировка по client+location, фильтрация по «прошло > 30 мин после windowTo».
  interface Stop {
    clientName: string
    locationName: string
    windowTo: string
    portions: number
    orderIds: string[]
    minutesLate: number
  }
  const stops = new Map<string, Stop>()
  for (const o of candidates) {
    const windowTo = o.location.deliveryWindowTo
    if (!windowTo) continue
    const minutesLate = minutesPastWindow(windowTo, todayMsk, now)
    if (minutesLate < LATE_THRESHOLD_MIN) continue

    const key = `${o.clientId}:${o.locationId}`
    const existing = stops.get(key)
    if (existing) {
      existing.portions += o.portions
      existing.orderIds.push(o.id)
    } else {
      stops.set(key, {
        clientName: o.client.name,
        locationName: o.location.name,
        windowTo,
        portions: o.portions,
        orderIds: [o.id],
        minutesLate,
      })
    }
  }

  const sent: string[] = []
  const errors: Array<{ stopKey: string; reason: string }> = []

  for (const [key, stop] of stops) {
    const text =
      `⚠️ <b>Опоздание</b>\n\n` +
      `Клиент: ${escapeHtml(stop.clientName)}\n` +
      `Точка: ${escapeHtml(stop.locationName)}\n` +
      `Окно до: ${stop.windowTo} (прошло ${stop.minutesLate} мин)\n` +
      `Объём: ${formatPortions(stop.portions)}`
    const result = await notifyGroup(text, { parseMode: 'HTML' })
    if (result.ok) {
      // Только при успешной отправке проставляем lateAlertSentAt, чтобы
      // повторная попытка прошла, если Telegram сейчас лежит.
      await prisma.order.updateMany({
        where: { id: { in: stop.orderIds } },
        data: { lateAlertSentAt: now },
      })
      sent.push(key)
    } else {
      errors.push({ stopKey: key, reason: result.error ?? 'unknown' })
    }
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: todayMsk.toISOString().slice(0, 10),
      payload: { sent: sent.length, errors: errors.length, details: errors },
    },
  })

  return NextResponse.json({ ok: true, sent: sent.length, errors })
}

function minutesPastWindow(windowToHHmm: string, deliveryDate: Date, now: Date): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(windowToHHmm)
  if (!m) return 0
  const hours = Number(m[1])
  const minutes = Number(m[2])
  // deliveryDate — UTC-полночь МСК-даты. Окно «HH:mm МСК» = (HH-3):mm UTC.
  const windowEnd = new Date(deliveryDate)
  windowEnd.setUTCHours(hours - MSK_OFFSET_HOURS, minutes, 0, 0)
  return Math.floor((now.getTime() - windowEnd.getTime()) / 60_000)
}
