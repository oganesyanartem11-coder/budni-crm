import { NextResponse } from 'next/server'
import type { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { pluralize } from '@/lib/utils/format'
import { ACTIVE_ORDER_STATUSES } from '@/lib/constants/order'
import { formatMoneyRu, formatDateWithDay } from '@/lib/digest/format'

export const dynamic = 'force-dynamic'

const ACTION = 'END_OF_DAY_DIGEST_SENT'

// Сегодняшние «реальные» заказы: всё что было в работе хотя бы в одной стадии,
// плюс уже доставленные. CANCELLED/DRAFT/PENDING_CONFIRMATION на дне не считаем.
const TODAY_STATUSES: OrderStatus[] = [...ACTIVE_ORDER_STATUSES, 'DELIVERED']

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
  const tomorrowMsk = mskMidnightUtc(now, 1)
  const todayIso = todayMsk.toISOString().slice(0, 10)

  // Идемпотентность: один дайджест на МСК-сутки.
  const alreadyRan = await prisma.activityLog.findFirst({
    where: { action: ACTION, createdAt: { gte: todayMsk } },
    select: { id: true },
  })
  if (alreadyRan) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  // TODO: Sprint 6.5 — добавить getMaterialCostForRange (себестоимость сырья из IngredientPriceHistory) + строки «Себестоимость» и «Маржа». Требует unit-тестов на связку Order ↔ MenuDayDish ↔ Dish ↔ IngredientPriceHistory.
  const [todayAgg, tomorrowOrders] = await Promise.all([
    prisma.order.aggregate({
      where: {
        deliveryDate: todayMsk,
        status: { in: TODAY_STATUSES },
      },
      _sum: { totalPrice: true, portions: true },
    }),
    prisma.order.findMany({
      where: {
        deliveryDate: tomorrowMsk,
        status: { in: ACTIVE_ORDER_STATUSES },
      },
      select: {
        portions: true,
        clientId: true,
        status: true,
        client: { select: { name: true } },
      },
    }),
  ])

  const totalRevenueToday = Number(todayAgg._sum.totalPrice ?? 0)
  const totalPortionsToday = todayAgg._sum.portions ?? 0
  const todayHasOrders = totalPortionsToday > 0 || totalRevenueToday > 0

  const totalPortionsTomorrow = tomorrowOrders.reduce((s, o) => s + o.portions, 0)
  const pendingTomorrow = tomorrowOrders.filter((o) => o.status === 'PENDING_CONFIRMATION').length

  // Группировка завтрашних заказов по клиенту: ВСЕ клиенты, по убыванию порций.
  const byClient = new Map<string, { name: string; portions: number }>()
  for (const o of tomorrowOrders) {
    const prev = byClient.get(o.clientId)
    if (prev) {
      prev.portions += o.portions
    } else {
      byClient.set(o.clientId, { name: o.client.name, portions: o.portions })
    }
  }
  const clientsTomorrow = Array.from(byClient.values()).sort((a, b) => b.portions - a.portions)

  const tomorrowHasOrders = clientsTomorrow.length > 0

  // ── Сборка сообщения ────────────────────────────────────────────────
  const todayLabel = formatDateWithDay(todayMsk)
  const tomorrowLabel = formatDateWithDay(tomorrowMsk)

  const blocks: string[] = []

  blocks.push(`🌙 <b>Итог дня ${escapeHtml(todayLabel)}</b>`)

  if (todayHasOrders) {
    blocks.push(
      `💰 <b>Выручка:</b> ${formatMoneyRu(totalRevenueToday)}\n` +
        `🍽 <b>Порций:</b> ${totalPortionsToday}`
    )
  } else {
    blocks.push('Заказов не было.')
  }

  const tomorrowLines: string[] = []
  tomorrowLines.push(`📅 <b>Завтра ${escapeHtml(tomorrowLabel)}:</b>`)
  if (tomorrowHasOrders) {
    tomorrowLines.push(
      `🍽 <b>Порций к производству:</b> ${totalPortionsTomorrow}`
    )
    for (const c of clientsTomorrow) {
      const word = pluralize(c.portions, ['порция', 'порции', 'порций'])
      tomorrowLines.push(`   • ${escapeHtml(c.name)} — ${c.portions} ${word}`)
    }
  } else {
    // Однострочный вариант: «Завтра 23.05 (Сб): пока пусто» — заменяет заголовок выше.
    tomorrowLines.length = 0
    tomorrowLines.push(`📅 <b>Завтра ${escapeHtml(tomorrowLabel)}:</b> пока пусто`)
  }
  if (pendingTomorrow > 0) {
    tomorrowLines.push(`⏳ <b>Ждут подтверждения:</b> ${pendingTomorrow}`)
  }
  blocks.push(tomorrowLines.join('\n'))

  const text = blocks.join('\n\n')

  const result = await notifyGroup(text, { parseMode: 'HTML' })

  if (!result.ok) {
    console.error(`[end-of-day-digest] notifyGroup failed: ${result.error}`)
  }

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: todayIso,
      payload: {
        date: todayIso,
        revenue: totalRevenueToday,
        portionsToday: totalPortionsToday,
        portionsTomorrow: totalPortionsTomorrow,
        pendingTomorrow,
        sentToGroup: result.ok,
        error: result.error ?? null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    date: todayIso,
    revenue: totalRevenueToday,
    portionsToday: totalPortionsToday,
    portionsTomorrow: totalPortionsTomorrow,
    pendingTomorrow,
    sentToGroup: result.ok,
    error: result.error ?? null,
  })
}
