import { NextResponse } from 'next/server'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import type { MealType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { productionSummaryButton } from '@/lib/telegram/buttons'
import { formatPortions, formatLocations, formatClients } from '@/lib/utils/format'

export const dynamic = 'force-dynamic'

const ACTION = 'PRODUCTION_SUMMARY_SENT'

const MEAL_TYPE_LABEL: Record<MealType, string> = {
  BREAKFAST: 'Завтрак',
  LUNCH: 'Обед',
  DINNER: 'Ужин',
}

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
  const tomorrowIso = tomorrowMsk.toISOString().slice(0, 10)

  // Идемпотентность на сутки (защита от Vercel cron retry).
  const alreadyRan = await prisma.activityLog.findFirst({
    where: { action: ACTION, createdAt: { gte: todayMsk } },
    select: { id: true },
  })
  if (alreadyRan) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const orders = await prisma.order.findMany({
    where: {
      deliveryDate: tomorrowMsk,
      status: { notIn: ['CANCELLED'] },
    },
    include: {
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      sourceConfig: { select: { orderType: true } },
    },
  })

  const button = productionSummaryButton(tomorrowIso)
  const dateLabel = format(tomorrowMsk, 'EEEEEE, d MMMM', { locale: ru })

  // Кейс: на завтра нет заказов.
  if (orders.length === 0) {
    const text =
      `📦 На завтра, <i>${escapeHtml(dateLabel)}</i>\n\n` +
      `Заказов пока нет. Менеджеры — проверьте, всё ли в порядке.`
    const result = await notifyGroup(text, { parseMode: 'HTML', replyMarkup: button })

    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'System',
        entityId: tomorrowIso,
        payload: { date: tomorrowIso, total: 0, sentToGroup: result.ok, empty: true },
      },
    })

    return NextResponse.json({ ok: true, date: tomorrowIso, total: 0, sentToGroup: result.ok })
  }

  // Метрики.
  const totalPortions = orders.reduce((s, o) => s + o.portions, 0)
  const uniqueClientIds = new Set(orders.map((o) => o.client.id))
  const uniqueLocationIds = new Set(orders.map((o) => o.location.id))

  const byMealType: Record<MealType, number> = { BREAKFAST: 0, LUNCH: 0, DINNER: 0 }
  for (const o of orders) {
    byMealType[o.mealType] += o.portions
  }

  const dynamicOrders = orders.filter((o) => o.sourceConfig?.orderType !== 'FIXED')
  const fixedOrders = orders.filter((o) => o.sourceConfig?.orderType === 'FIXED')

  // "Не ответили" — активные DYNAMIC-конфиги на завтра без созданного Order.
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
  const activeConfigsForTomorrow = dynamicConfigs.filter((c) => isScheduledForDate(c, tomorrowMsk))
  const confirmedConfigIds = new Set(
    orders.map((o) => o.sourceConfigId).filter((id): id is string => id !== null)
  )
  const unconfirmed = activeConfigsForTomorrow.filter((c) => !confirmedConfigIds.has(c.id))

  // Группируем dynamic/fixed по клиенту+локации (несколько mealConfig'ов на
  // одной локации = одна строка с суммарными порциями).
  const groupOrders = (
    list: typeof orders
  ): Array<{ clientName: string; locationName: string; portions: number }> => {
    const map = new Map<string, { clientName: string; locationName: string; portions: number }>()
    for (const o of list) {
      const key = `${o.client.id}:${o.location.id}`
      const existing = map.get(key)
      if (existing) existing.portions += o.portions
      else
        map.set(key, {
          clientName: o.client.name,
          locationName: o.location.name,
          portions: o.portions,
        })
    }
    return Array.from(map.values()).sort((a, b) => a.clientName.localeCompare(b.clientName, 'ru'))
  }

  const dynamicGroups = groupOrders(dynamicOrders)
  const fixedGroups = groupOrders(fixedOrders)

  // Сборка текста.
  const lines: string[] = []
  lines.push(`📦 На завтра, <i>${escapeHtml(dateLabel)}</i>`)
  lines.push('')
  lines.push(
    `<b>${formatPortions(totalPortions)}</b> · ${formatLocations(uniqueLocationIds.size)} · ${formatClients(uniqueClientIds.size)}`
  )

  const mealTypeOrder: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']
  const nonEmptyMealTypes = mealTypeOrder.filter((t) => byMealType[t] > 0)
  if (nonEmptyMealTypes.length > 0) {
    lines.push(
      nonEmptyMealTypes.map((t) => `${MEAL_TYPE_LABEL[t]}: ${byMealType[t]}`).join(' · ')
    )
  }

  if (dynamicGroups.length > 0) {
    lines.push('')
    lines.push(`✅ Подтверждено (${dynamicGroups.length}):`)
    for (const g of dynamicGroups) {
      lines.push(
        `• ${escapeHtml(g.clientName)} (${escapeHtml(g.locationName)}) — ${formatPortions(g.portions)}`
      )
    }
  }

  if (fixedGroups.length > 0) {
    lines.push('')
    lines.push(`🔁 Фиксированные (${fixedGroups.length}):`)
    for (const g of fixedGroups) {
      lines.push(
        `• ${escapeHtml(g.clientName)} (${escapeHtml(g.locationName)}) — ${formatPortions(g.portions)}`
      )
    }
  }

  if (unconfirmed.length > 0) {
    lines.push('')
    lines.push(`⚠️ Не ответили (${unconfirmed.length}):`)
    // Группируем «не ответил» тоже по клиенту+локации, чтобы 2 mealType на одной
    // точке не дублировали строку.
    const seen = new Set<string>()
    for (const c of unconfirmed) {
      const locName = c.location.name
      const key = `${c.client.name}::${locName}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`• ${escapeHtml(c.client.name)} (${escapeHtml(locName)})`)
    }
  }

  lines.push('')
  lines.push('ℹ️ Аллергии, контакты, окно доставки — в CRM.')

  const text = lines.join('\n')
  const result = await notifyGroup(text, { parseMode: 'HTML', replyMarkup: button })

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: tomorrowIso,
      payload: {
        date: tomorrowIso,
        total: totalPortions,
        clients: uniqueClientIds.size,
        locations: uniqueLocationIds.size,
        dynamic: dynamicGroups.length,
        fixed: fixedGroups.length,
        unconfirmed: unconfirmed.length,
        sentToGroup: result.ok,
        error: result.error ?? null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    date: tomorrowIso,
    total: totalPortions,
    clients: uniqueClientIds.size,
    locations: uniqueLocationIds.size,
    dynamic_groups: dynamicGroups.length,
    fixed_groups: fixedGroups.length,
    unconfirmed: unconfirmed.length,
    sentToGroup: result.ok,
    error: result.error ?? null,
  })
}
