import { NextResponse } from 'next/server'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { isScheduledForDate } from '@/lib/orders/generate-orders'
import { notifyProductionChannel, escapeHtml } from '@/lib/telegram/notify'
import { productionSummaryButton } from '@/lib/telegram/buttons'
import {
  formatProductionSummary,
  computeUnconfirmedConfigs,
} from '@/lib/boris/production-summary-format'
import { sumDeliveryRevenue } from '@/lib/db/queries/delivery-revenue'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const ACTION = 'PRODUCTION_SUMMARY_SENT'

async function handler(_request: Request) {
  const now = new Date()
  const todayMsk = mskMidnightUtc(now, 0)
  const tomorrowMsk = mskMidnightUtc(now, 1)
  const dayAfterMsk = mskMidnightUtc(now, 2)
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
    select: {
      portions: true,
      totalPrice: true,
      sourceConfigId: true,
      clientId: true,
      locationId: true,
      mealType: true,
      status: true,
      client: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
    },
  })

  const button = productionSummaryButton(tomorrowIso)
  const dateLabel = format(tomorrowMsk, 'EEEEEE, d MMMM', { locale: ru })

  // Кейс: на завтра нет заказов.
  if (orders.length === 0) {
    const text =
      `📦 На завтра, <i>${escapeHtml(dateLabel)}</i>\n\n` +
      `Заказов пока нет. Менеджеры — проверьте, всё ли в порядке.`
    // notifyProductionChannel сам делает фолбэк в ADMIN_PRO при недоступности
    // канала производства и не возвращает результат — доставка гарантирована
    // (либо канал, либо личка), поэтому sentToGroup=true.
    await notifyProductionChannel(text, { parseMode: 'HTML', replyMarkup: button })

    await prisma.activityLog.create({
      data: {
        userId: null,
        userRole: 'ADMIN',
        action: ACTION,
        entityType: 'System',
        entityId: tomorrowIso,
        payload: { date: tomorrowIso, total: 0, sentToGroup: true, empty: true },
      },
    })

    return NextResponse.json({ ok: true, date: tomorrowIso, total: 0, sentToGroup: true })
  }

  // Метрики.
  const totalPortions = orders.reduce((s, o) => s + o.portions, 0)
  const totalRevenue = orders.reduce((s, o) => s + Number(o.totalPrice), 0)
  // Волна 4: сервисная выручка (доставка) на завтра — для хвоста «+ X ₽ доставка».
  const deliveryRevenue = Number(await sumDeliveryRevenue({ from: tomorrowMsk, to: dayAfterMsk }))
  const uniqueClientIds = new Set(orders.map((o) => o.client.id))
  const uniqueLocationIds = new Set(orders.map((o) => o.location.id))

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
  // П3-механизм1: матчинг «отвечен» по бизнес-ключу (clientId, locationId, mealType)
  // вместо sourceConfigId — ручной MANUAL-заказ (sourceConfigId=null) теперь
  // корректно «закрывает» свой DYNAMIC-конфиг. См. computeUnconfirmedConfigs.
  const unconfirmedConfigs = computeUnconfirmedConfigs(activeConfigsForTomorrow, orders)

  // Единый список заказов на завтра (подтверждённые DYNAMIC + фиксированные FIXED),
  // сгруппированный по клиент+локация: несколько mealConfig'ов на одной точке =
  // одна строка с суммарными порциями. Разные локации одного клиента = разные строки.
  const orderMap = new Map<
    string,
    { clientId: string; clientName: string; locationId: string; locationName: string; portions: number }
  >()
  for (const o of orders) {
    const key = `${o.client.id}:${o.location.id}`
    const existing = orderMap.get(key)
    if (existing) existing.portions += o.portions
    else
      orderMap.set(key, {
        clientId: o.client.id,
        clientName: o.client.name,
        locationId: o.location.id,
        locationName: o.location.name,
        portions: o.portions,
      })
  }
  const orderRows = Array.from(orderMap.values())

  // "Не ответили" — дедуп по клиент+локация.
  const unconfirmedMap = new Map<string, { clientName: string; locationName: string }>()
  for (const c of unconfirmedConfigs) {
    const key = `${c.client.name}::${c.location.name}`
    if (!unconfirmedMap.has(key))
      unconfirmedMap.set(key, { clientName: c.client.name, locationName: c.location.name })
  }
  const unconfirmedRows = Array.from(unconfirmedMap.values())

  const text = formatProductionSummary({
    dateLabel,
    orders: orderRows,
    totalPortions,
    totalRevenue,
    deliveryRevenue,
    unconfirmed: unconfirmedRows,
  })
  // notifyProductionChannel: канал производства с фолбэком в личку ADMIN_PRO.
  // Доставка гарантирована (канал или личка), результат не возвращается →
  // sentToGroup=true, error=null.
  await notifyProductionChannel(text, { parseMode: 'HTML', replyMarkup: button })

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
        revenue: totalRevenue,
        deliveryRevenue,
        clients: uniqueClientIds.size,
        locations: uniqueLocationIds.size,
        orders: orderRows.length,
        unconfirmed: unconfirmedRows.length,
        sentToGroup: true,
        error: null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    date: tomorrowIso,
    total: totalPortions,
    revenue: totalRevenue,
    deliveryRevenue,
    clients: uniqueClientIds.size,
    locations: uniqueLocationIds.size,
    orders: orderRows.length,
    unconfirmed: unconfirmedRows.length,
    sentToGroup: true,
    error: null,
  })
}

export const GET = withCronHeartbeat('production-summary', handler)
