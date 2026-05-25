import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { notifyGroup, escapeHtml } from '@/lib/telegram/notify'
import { getFinancialWeek, getPreviousFinancialWeek } from '@/lib/utils/week'
import { pluralize } from '@/lib/utils/format'
import { REVENUE_STATUSES } from '@/lib/constants/order'
import { getMaterialCostForRange } from '@/lib/digest/material-cost'
import {
  formatMoneyRu,
  formatWowLine,
  formatDate,
  formatDayName,
  formatMarginLines,
} from '@/lib/digest/format'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'

export const dynamic = 'force-dynamic'

const ACTION = 'FRIDAY_WEEK_DIGEST_SENT'

const LOG_PREFIX = '[friday-week-digest]'

async function handler(_request: Request) {
  const now = new Date()
  const todayMsk = mskMidnightUtc(now, 0)

  // Идемпотентность в пределах суток МСК — на случай ручного повторного
  // запуска. День-недели (пятницу) гарантирует cron-расписание.
  const alreadyRan = await prisma.activityLog.findFirst({
    where: { action: ACTION, createdAt: { gte: todayMsk } },
    select: { id: true },
  })
  if (alreadyRan) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'already_ran_today' })
  }

  const thisWeek = getFinancialWeek(now)
  const prevWeek = getPreviousFinancialWeek(now)

  const [thisWeekOrders, prevAgg, materialCostThisWeek] = await Promise.all([
    prisma.order.findMany({
      where: {
        deliveryDate: { gte: thisWeek.from, lte: thisWeek.to },
        status: { in: REVENUE_STATUSES },
      },
      select: {
        id: true,
        deliveryDate: true,
        portions: true,
        totalPrice: true,
        clientId: true,
        client: { select: { name: true } },
      },
    }),
    prisma.order.aggregate({
      where: {
        deliveryDate: { gte: prevWeek.from, lte: prevWeek.to },
        status: { in: REVENUE_STATUSES },
      },
      _sum: { totalPrice: true, portions: true },
      _count: { _all: true },
    }),
    getMaterialCostForRange(thisWeek.from, thisWeek.to, REVENUE_STATUSES),
  ])

  // === Агрегаты по текущей неделе ===
  const totalRevenue = thisWeekOrders.reduce((s, o) => s + Number(o.totalPrice), 0)
  const totalPortions = thisWeekOrders.reduce((s, o) => s + o.portions, 0)
  const totalOrders = thisWeekOrders.length

  const prevRevenue = prevAgg._sum.totalPrice ? Number(prevAgg._sum.totalPrice) : 0
  const prevPortions = prevAgg._sum.portions ?? 0

  // === Топ-3 клиента по порциям ===
  const byClient = new Map<string, { name: string; portions: number }>()
  for (const o of thisWeekOrders) {
    const cur = byClient.get(o.clientId)
    if (cur) {
      cur.portions += o.portions
    } else {
      byClient.set(o.clientId, { name: o.client.name, portions: o.portions })
    }
  }
  const top3 = Array.from(byClient.values())
    .sort((a, b) => b.portions - a.portions)
    .slice(0, 3)

  // === Пиковый день: max порций; tie-break — раньше по дате ===
  const byDay = new Map<string, { date: Date; portions: number }>()
  for (const o of thisWeekOrders) {
    const iso = o.deliveryDate.toISOString().slice(0, 10)
    const cur = byDay.get(iso)
    if (cur) {
      cur.portions += o.portions
    } else {
      byDay.set(iso, { date: o.deliveryDate, portions: o.portions })
    }
  }
  const peakDay = Array.from(byDay.values()).sort((a, b) => {
    if (b.portions !== a.portions) return b.portions - a.portions
    return a.date.getTime() - b.date.getTime()
  })[0]

  // === Средний чек ===
  const avgCheck = totalOrders === 0 ? null : Math.round(totalRevenue / totalOrders)

  // === Новые клиенты на этой неделе ===
  // Стратегия: берём только клиентов, у которых есть заказ на этой неделе
  // (это уже ограничивает выборку до ~10-30 шт.), затем для каждого делаем
  // findFirst по самой ранней дате доставки среди ВСЕХ его заказов. Если
  // эта дата попала в [thisWeek.from, thisWeek.to] — клиент новый.
  // Альтернатива (groupBy clientId с _min deliveryDate) дала бы один
  // запрос, но фильтр «min within range» в Prisma не выражается напрямую;
  // фильтровать на JS-стороне всё равно пришлось бы, а такой groupBy
  // прошёлся бы по всей таблице Order. Promise.all с findFirst при индексе
  // по (clientId, deliveryDate) — дешевле и предсказуемее.
  const candidateClientIds = Array.from(byClient.keys())
  const earliestPerClient = await Promise.all(
    candidateClientIds.map(async (clientId) => {
      const earliest = await prisma.order.findFirst({
        where: { clientId, status: { in: REVENUE_STATUSES } },
        orderBy: { deliveryDate: 'asc' },
        select: { deliveryDate: true },
      })
      return { clientId, earliest: earliest?.deliveryDate ?? null }
    })
  )
  const newClients = earliestPerClient
    .filter((x) => x.earliest && x.earliest >= thisWeek.from && x.earliest <= thisWeek.to)
    .map((x) => byClient.get(x.clientId)!)
    .filter(Boolean)

  // === Сборка текста ===
  const headerRange =
    `${formatDayName(thisWeek.from)} ${formatDate(thisWeek.from)} – ` +
    `${formatDayName(thisWeek.to)} ${formatDate(thisWeek.to)}`

  const blocks: string[] = []

  blocks.push(`🎉 <b>Итог недели</b> ${escapeHtml(headerRange)}`)

  // Выручка
  {
    const lines = [`💰 <b>Выручка:</b> ${escapeHtml(formatMoneyRu(totalRevenue))}`]
    const wow = formatWowLine(totalRevenue, prevRevenue)
    if (wow) lines.push(`   ${escapeHtml(wow)}`)
    blocks.push(lines.join('\n'))
  }

  // Порции
  {
    const lines = [
      `🍽 <b>Порций:</b> ${escapeHtml(totalPortions.toLocaleString('ru-RU'))}`,
    ]
    const wow = formatWowLine(totalPortions, prevPortions)
    if (wow) lines.push(`   ${escapeHtml(wow)}`)
    blocks.push(lines.join('\n'))
  }

  // Себестоимость + маржа (без WoW — оставлено на отдельный заход,
  // чтобы не удваивать БД-нагрузку cron'а вторым проходом по прошлой неделе).
  const marginLines = formatMarginLines(
    totalRevenue,
    materialCostThisWeek.totalCost,
    materialCostThisWeek.daysWithoutMenu,
    materialCostThisWeek.totalDays
  )
  if (marginLines.length > 0) {
    blocks.push(marginLines.join('\n'))
  }

  // Топ-3 клиента
  if (top3.length > 0) {
    const lines = ['🏆 <b>Топ-3 клиента:</b>']
    top3.forEach((c, i) => {
      const portionsWord = pluralize(c.portions, ['порция', 'порции', 'порций'])
      lines.push(`${i + 1}. ${escapeHtml(c.name)} — ${c.portions} ${portionsWord}`)
    })
    blocks.push(lines.join('\n'))
  }

  // Пиковый день
  if (peakDay) {
    const dayLabel = formatDayName(peakDay.date)
    const portionsWord = pluralize(peakDay.portions, ['порция', 'порции', 'порций'])
    blocks.push(
      `📈 <b>Пиковый день:</b> ${escapeHtml(dayLabel)}, ${peakDay.portions} ${portionsWord}`
    )
  }

  // Новые клиенты — скрываем, если 0
  if (newClients.length > 0) {
    const shown = newClients.slice(0, 5).map((c) => escapeHtml(c.name))
    const tail = newClients.length > 5 ? `, и ещё ${newClients.length - 5}` : ''
    blocks.push(
      `🆕 <b>Новых клиентов:</b> ${newClients.length} (${shown.join(', ')}${tail})`
    )
  }

  // Средний чек — скрываем, если 0 заказов
  if (avgCheck !== null) {
    blocks.push(`📊 <b>Средний чек:</b> ${escapeHtml(formatMoneyRu(avgCheck))}`)
  }

  const text = blocks.join('\n\n')

  const result = await notifyGroup(text, { parseMode: 'HTML' })
  if (!result.ok) {
    console.error(`${LOG_PREFIX} notifyGroup failed: ${result.error}`)
  } else {
    console.log(
      `${LOG_PREFIX} sent: revenue=${totalRevenue} portions=${totalPortions} orders=${totalOrders}`
    )
  }

  const weekFromIso = thisWeek.from.toISOString().slice(0, 10)
  const weekToIso = thisWeek.to.toISOString().slice(0, 10)

  await prisma.activityLog.create({
    data: {
      userId: null,
      userRole: 'ADMIN',
      action: ACTION,
      entityType: 'System',
      entityId: weekFromIso,
      payload: {
        weekFrom: weekFromIso,
        weekTo: weekToIso,
        revenue: totalRevenue,
        portions: totalPortions,
        orders: totalOrders,
        topClientsCount: top3.length,
        peakDayPortions: peakDay?.portions ?? 0,
        newClientsCount: newClients.length,
        sentToGroup: result.ok,
        error: result.error ?? null,
      },
    },
  })

  return NextResponse.json({
    ok: true,
    weekFrom: weekFromIso,
    weekTo: weekToIso,
    revenue: totalRevenue,
    portions: totalPortions,
    orders: totalOrders,
    topClientsCount: top3.length,
    peakDayPortions: peakDay?.portions ?? 0,
    newClientsCount: newClients.length,
    sentToGroup: result.ok,
    error: result.error ?? null,
  })
}

export const GET = withCronHeartbeat('friday-week-digest', handler)
