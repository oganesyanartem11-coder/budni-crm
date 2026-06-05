/**
 * Cron-эндпоинт «Доброе утро. Сегодня на доставку» (П13, MEGA-3).
 *
 * Расписание (vercel.json): "0 6 * * *" UTC = 9:00 МСК ежедневно.
 *
 * Шлёт в групповой TG-чат менеджеров детерминированную сводку отгрузок на
 * СЕГОДНЯ: по строке на локацию (LocationName — N порций), отсортировано
 * алфавитно, плюс итог (порции + ₽) и короткая фраза «от Бори» (ротация по
 * дню недели МСК — детерминированно, без Math.random).
 *
 * Все даты/время — строго МСК (mskMidnightUtc).
 * Идемпотентность на сутки через alreadyRanToday/markRanToday.
 */

import { NextResponse } from 'next/server'
import { mskMidnightUtc, alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import {
  buildNineAmSummary,
  type NineAmOrderRow,
} from '@/lib/boris/morning/nine-am-summary'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { prisma } from '@/lib/db/prisma'
import { sumDeliveryRevenue } from '@/lib/db/queries/delivery-revenue'
import type { OrderStatus } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-9am-summary'

// На доставку сегодня попадают только реально готовящиеся заказы.
// Исключаем CANCELLED, DRAFT, PENDING_CONFIRMATION (ещё не подтверждены).
const DELIVERY_STATUSES: OrderStatus[] = ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION']

async function handler(request: Request) {
  const now = new Date()
  const url = new URL(request.url)
  const force = url.searchParams.get('force') === 'true'
  const isDryRun = url.searchParams.get('dryRun') === 'true'

  // Идемпотентность на сутки (защита от Vercel cron retry).
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  const todayMsk = mskMidnightUtc(now, 0)
  const tomorrowMsk = mskMidnightUtc(now, 1)

  const [orders, deliveryToday] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: todayMsk,
        status: { in: DELIVERY_STATUSES },
      },
      select: {
        portions: true,
        totalPrice: true,
        location: { select: { id: true, name: true } },
      },
    }),
    // Волна 4: сервисная выручка (доставка) за сегодня — отдельной строкой.
    sumDeliveryRevenue({ from: todayMsk, to: tomorrowMsk }),
  ])

  const rows: NineAmOrderRow[] = orders.map((o) => ({
    locationId: o.location.id,
    locationName: o.location.name,
    portions: o.portions,
    totalPrice: Number(o.totalPrice),
  }))

  const text = buildNineAmSummary(rows, now, escapeHtml, Number(deliveryToday))

  if (isDryRun) {
    await markRanToday(JOB_LABEL, { dryRun: true, orders: rows.length })
    return NextResponse.json({ ok: true, dryRun: true, orders: rows.length, text })
  }

  const result = await notifyGroup(text, { parseMode: 'HTML' })

  await markRanToday(JOB_LABEL, {
    orders: rows.length,
    sentToGroup: result.ok,
    error: result.error ?? null,
  })

  return NextResponse.json({ ok: true, orders: rows.length, sentToGroup: result.ok })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
