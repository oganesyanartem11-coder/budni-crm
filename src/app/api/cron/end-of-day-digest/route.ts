import { NextResponse } from 'next/server'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { reportsButton } from '@/lib/telegram/buttons'
import { formatPortions } from '@/lib/utils/format'

export const dynamic = 'force-dynamic'

const ACTION = 'END_OF_DAY_DIGEST_SENT'

// Заказы, которые сегодня были «в работе» хотя бы в одной из стадий.
// CANCELLED/DRAFT/PENDING_CONFIRMATION в итоговую цифру дня не идут.
const END_OF_DAY_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]

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
  const todayIso = todayMsk.toISOString().slice(0, 10)

  // Идемпотентность.
  const alreadyRan = await prisma.activityLog.findFirst({
    where: { action: ACTION, createdAt: { gte: todayMsk } },
    select: { id: true },
  })
  if (alreadyRan) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: { in: END_OF_DAY_STATUSES },
    },
    select: { portions: true, status: true, clientId: true },
  })

  const button = reportsButton(todayIso)
  const dateLabel = format(todayMsk, 'EEEEEE, d MMMM', { locale: ru })

  if (orders.length === 0) {
    const text = `🌙 День закрыт, <i>${escapeHtml(dateLabel)}</i>\n\nСегодня не было заказов.`
    const result = await notifyGroup(text, { parseMode: 'HTML', replyMarkup: button })

    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'System',
        entityId: todayIso,
        payload: { date: todayIso, total: 0, sentToGroup: result.ok, empty: true },
      },
    })

    return NextResponse.json({ ok: true, date: todayIso, total: 0, sentToGroup: result.ok })
  }

  const totalPortions = orders.reduce((s, o) => s + o.portions, 0)
  const clientCount = new Set(orders.map((o) => o.clientId)).size
  const deliveredCount = orders.filter((o) => o.status === 'DELIVERED').length

  const text =
    `🌙 День закрыт, <i>${escapeHtml(dateLabel)}</i>\n\n` +
    `Отгружено: <b>${formatPortions(totalPortions)}</b>\n` +
    `Клиентов: ${clientCount}\n` +
    `Доставлено: ${deliveredCount}/${orders.length}\n\n` +
    `ℹ️ Детали и динамика — в аналитике.`

  const result = await notifyGroup(text, { parseMode: 'HTML', replyMarkup: button })

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: todayIso,
      payload: {
        date: todayIso,
        total: totalPortions,
        orders: orders.length,
        delivered: deliveredCount,
        clients: clientCount,
        sentToGroup: result.ok,
        error: result.error ?? null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    date: todayIso,
    total: totalPortions,
    orders: orders.length,
    delivered: deliveredCount,
    clients: clientCount,
    sentToGroup: result.ok,
    error: result.error ?? null,
  })
}
