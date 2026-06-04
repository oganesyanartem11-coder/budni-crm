/**
 * Morning context builder для Бориса (Спринт 7.16.B).
 *
 * Собирает структурированные факты о текущем дне для последующей генерации
 * утреннего брифинга через LLM. Чистая функция — не пишет в БД, не шлёт TG.
 *
 * Возвращает null если на сегодня нет ни одной активной порции — в этом
 * случае cron пропускает день (нечего рассказывать).
 */

import { prisma } from '@/lib/db/prisma'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { ACTIVE_ORDER_STATUSES } from '@/lib/constants/order'

export type AttentionItem = {
  type:
    | 'rude_client_with_delivery'
    | 'urgent_client_with_delivery'
    | 'first_delivery'
    | 'unconfirmed_dynamic'
    | 'unconfirmed_sameday_today'
    | 'ingredient_price_spike'
    | 'menu_repetition'
  severity: 'high' | 'medium' | 'low'
  description: string
  relatedData: Record<string, unknown>
}

/** Формат cut-off локации как «HH:mm» (fallback 16:00 если поля null). */
function formatCutoff(hour: number | null | undefined, minute: number | null | undefined): string {
  const h = (hour ?? 16).toString().padStart(2, '0')
  const m = (minute ?? 0).toString().padStart(2, '0')
  return `${h}:${m}`
}

export type TrendItem = {
  kind: string
  description: string
  relatedData?: Record<string, unknown>
}

export type ChargeContext = {
  recommendCharge: boolean
  triggers: string[]
}

export type MorningContext = {
  todayIso: string
  tomorrowIso: string
  weekdayMsk: number // 1..7 (Пн=1, Вс=7)
  attention: AttentionItem[]
  day: {
    totalPortionsToday: number
    pendingConfirmationTomorrow: number
    // П12: SAME-DAY локации, которые сегодня ещё не подтвердили заказ (deliveryDate=сегодня,
    // status=PENDING_CONFIRMATION). У них индивидуальный утренний cut-off (cutoffLabel «HH:mm»),
    // обычный pendingConfirmationTomorrow их не ловит (там фильтр по завтрашней дате).
    pendingSameDayToday: { locationName: string; cutoffLabel: string }[]
    avgWeekdayPortions: number
    deltaPercent: number
  }
  trends: TrendItem[] | null
  chargeContext: ChargeContext | null
}

const FORTY_EIGHT_HOURS_MS = 48 * 3600_000
const PRICE_SPIKE_THRESHOLD_PERCENT = 10
const TOP_INGREDIENTS_LIMIT = 20
const WEEKDAY_AVG_WINDOW_DAYS = 5
const MAX_ATTENTION_ITEMS = 5
const STREAK_NO_COMPLAINTS_THRESHOLD_DAYS = 5
const ATTENTION_EXCERPT_LIMIT = 60

/**
 * Формирует description для attention-item по rude/urgent клиенту с доставкой сегодня.
 * Чистая функция (вынесена для тестируемости — context-builder требует БД).
 *
 * Формат с текстом сообщения: `От {clientName} ({locationName}): "{excerpt}…" [tone={tone}]`.
 * Если excerpt пустой (нет исходного текста) — деградирует до читаемого фолбэка
 * без кривых пустых кавычек.
 */
export function formatUrgentAttention(params: {
  clientName: string
  locationName: string
  excerpt: string
  tone: 'rude' | 'urgent'
}): string {
  const { clientName, locationName, excerpt, tone } = params
  const loc = locationName || '—'
  if (excerpt) {
    return `От ${clientName} (${loc}): "${excerpt}" [tone=${tone}]`
  }
  return `От ${clientName} (${loc}): срочное сообщение, сегодня доставка [tone=${tone}]`
}

/** Обрезает текст до limit символов, добавляя «…» если был длиннее. Пустой/null → ''. */
export function buildExcerpt(message: string | null | undefined, limit: number): string {
  if (!message) return ''
  const trimmed = message.trim()
  if (!trimmed) return ''
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…`
}

/**
 * Возвращает день недели МСК как 1..7 (Пн=1, Вс=7) для даты в UTC-полуночи МСК.
 * JS Date.getUTCDay(): Sun=0..Sat=6 → перекладываем в Пн=1..Вс=7.
 */
function mskWeekdayFromMidnight(midnight: Date): number {
  const d = midnight.getUTCDay()
  return d === 0 ? 7 : d
}

export async function buildMorningContext(now: Date): Promise<MorningContext | null> {
  const todayMsk = mskMidnightUtc(now, 0)
  const tomorrowMsk = mskMidnightUtc(now, 1)
  const now48hAgo = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS)

  const todayIso = todayMsk.toISOString().slice(0, 10)
  const tomorrowIso = tomorrowMsk.toISOString().slice(0, 10)
  const weekdayMsk = mskWeekdayFromMidnight(todayMsk)

  // ───────────────────────── DAY ─────────────────────────
  const todayOrders = await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: { in: ACTIVE_ORDER_STATUSES },
    },
    select: {
      clientId: true,
      locationId: true,
      portions: true,
      client: { select: { id: true, name: true } },
    },
  })

  const totalPortionsToday = todayOrders.reduce((s, o) => s + o.portions, 0)

  // Ранний выход — нет смысла собирать остальное.
  if (totalPortionsToday === 0) {
    return null
  }

  const pendingConfirmationTomorrow = await prisma.order.count({
    where: { deliveryDate: tomorrowMsk, status: 'PENDING_CONFIRMATION' },
  })

  // П12: SAME-DAY клиенты ставят заказ на СЕГОДНЯ (deliveryDate=today), не на завтра.
  // Поэтому pendingConfirmationTomorrow их не видит. Берём отдельно: pending-заказы
  // на сегодня, чьи локации same-day, и показываем с их утренним cut-off.
  const pendingSameDayOrders = await prisma.order.findMany({
    where: {
      deliveryDate: todayMsk,
      status: 'PENDING_CONFIRMATION',
      location: { sameDayDelivery: true },
    },
    select: {
      locationId: true,
      location: {
        select: { name: true, cutoffHourMsk: true, cutoffMinuteMsk: true },
      },
    },
  })
  // Дедуп по локации (несколько mealType на одной точке = одна строка).
  const pendingSameDayMap = new Map<string, { locationName: string; cutoffLabel: string }>()
  for (const o of pendingSameDayOrders) {
    if (pendingSameDayMap.has(o.locationId)) continue
    pendingSameDayMap.set(o.locationId, {
      locationName: o.location.name,
      cutoffLabel: formatCutoff(o.location.cutoffHourMsk, o.location.cutoffMinuteMsk),
    })
  }
  const pendingSameDayToday = Array.from(pendingSameDayMap.values()).sort((a, b) =>
    a.locationName.localeCompare(b.locationName, 'ru')
  )

  // Средний дневной totalPortions за последние 5 БУДНИХ дней (исключая сегодня).
  const weekdayMidnights: Date[] = []
  for (let offset = 1; weekdayMidnights.length < WEEKDAY_AVG_WINDOW_DAYS && offset < 30; offset++) {
    const m = mskMidnightUtc(now, -offset)
    const wd = mskWeekdayFromMidnight(m)
    if (wd >= 1 && wd <= 5) weekdayMidnights.push(m)
  }

  let avgWeekdayPortions = 0
  if (weekdayMidnights.length > 0) {
    const sums = await Promise.all(
      weekdayMidnights.map((d) =>
        prisma.order.aggregate({
          where: { deliveryDate: d, status: { in: ACTIVE_ORDER_STATUSES } },
          _sum: { portions: true },
        })
      )
    )
    const total = sums.reduce((s, r) => s + (r._sum.portions ?? 0), 0)
    avgWeekdayPortions = total / weekdayMidnights.length
  }

  const deltaPercent =
    avgWeekdayPortions > 0 ? ((totalPortionsToday - avgWeekdayPortions) / avgWeekdayPortions) * 100 : 0

  // ───────────────────────── ATTENTION ─────────────────────────
  const attention: AttentionItem[] = []

  // 1. rude/urgent клиенты с доставкой сегодня
  const recentAlerts = await prisma.clientAlertLog.findMany({
    where: { tone: { in: ['rude', 'urgent'] }, createdAt: { gte: now48hAgo } },
    select: {
      clientId: true,
      tone: true,
      createdAt: true,
      inboxItem: { select: { clientMessage: true } },
      client: {
        select: {
          id: true,
          name: true,
          locations: { select: { name: true, isActive: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Берём свежайший tone на клиента (+ название локации и excerpt сообщения).
  const latestToneByClient = new Map<
    string,
    { tone: 'rude' | 'urgent'; name: string; locationName: string; excerpt: string }
  >()
  for (const a of recentAlerts) {
    if (!latestToneByClient.has(a.clientId) && (a.tone === 'rude' || a.tone === 'urgent')) {
      // Для пилота у клиента 1 активная локация — берём первую активную.
      const activeLocation =
        a.client.locations.find((l) => l.isActive !== false) ?? a.client.locations[0]
      latestToneByClient.set(a.clientId, {
        tone: a.tone,
        name: a.client.name,
        locationName: activeLocation?.name ?? '',
        excerpt: buildExcerpt(a.inboxItem?.clientMessage, ATTENTION_EXCERPT_LIMIT),
      })
    }
  }

  const todayClientIds = new Set(todayOrders.map((o) => o.clientId))
  for (const [clientId, { tone, name, locationName, excerpt }] of latestToneByClient) {
    if (!todayClientIds.has(clientId)) continue
    attention.push({
      type: tone === 'rude' ? 'rude_client_with_delivery' : 'urgent_client_with_delivery',
      severity: 'high',
      description: formatUrgentAttention({ clientName: name, locationName, excerpt, tone }),
      relatedData: { clientId, clientName: name, tone, locationName, excerpt },
    })
  }

  // 2. Первая отгрузка нового клиента сегодня
  const uniqueTodayClients = Array.from(todayClientIds)
  const clientNameById = new Map(todayOrders.map((o) => [o.clientId, o.client.name]))

  const deliveredCounts = await Promise.all(
    uniqueTodayClients.map((cid) =>
      prisma.order.count({
        where: {
          clientId: cid,
          status: 'DELIVERED',
          deliveryDate: { lt: todayMsk },
        },
      })
    )
  )

  uniqueTodayClients.forEach((cid, idx) => {
    if (deliveredCounts[idx] === 0) {
      attention.push({
        type: 'first_delivery',
        severity: 'medium',
        description: `${clientNameById.get(cid) ?? 'клиент'}: первая отгрузка`,
        relatedData: { clientId: cid, clientName: clientNameById.get(cid) ?? null },
      })
    }
  })

  // 3. Не подтвердившие DYNAMIC на завтра
  if (pendingConfirmationTomorrow > 2) {
    attention.push({
      type: 'unconfirmed_dynamic',
      severity: 'medium',
      description: `${pendingConfirmationTomorrow} клиентов не подтвердили заказ на завтра`,
      relatedData: { count: pendingConfirmationTomorrow },
    })
  }

  // 3b. П12: SAME-DAY локации не подтвердили заказ на СЕГОДНЯ. Высокий приоритет —
  // у них утренний cut-off, времени мало. Каждую называем с её cut-off.
  for (const s of pendingSameDayToday) {
    attention.push({
      type: 'unconfirmed_sameday_today',
      severity: 'high',
      description: `${s.locationName}: не подтвердили на сегодня (утренние, cut-off ${s.cutoffLabel})`,
      relatedData: { locationName: s.locationName, cutoffLabel: s.cutoffLabel },
    })
  }

  // 4. Скачок цены ингредиента >10% за неделю
  // top-N ингредиентов по числу техкарт, в которых они используются
  // (proxy для «по использованию», без агрегации заказов).
  const topIngredientsGroups = await prisma.dishIngredient.groupBy({
    by: ['ingredientId'],
    _count: { ingredientId: true },
    orderBy: { _count: { ingredientId: 'desc' } },
    take: TOP_INGREDIENTS_LIMIT,
  })

  if (topIngredientsGroups.length > 0) {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000)

    const ingredients = await prisma.ingredient.findMany({
      where: { id: { in: topIngredientsGroups.map((g) => g.ingredientId) } },
      select: { id: true, name: true, pricePerUnit: true },
    })

    for (const ing of ingredients) {
      const historyWeekAgo = await prisma.ingredientPriceHistory.findFirst({
        where: { ingredientId: ing.id, validFrom: { lte: weekAgo } },
        orderBy: { validFrom: 'desc' },
        select: { price: true },
      })
      if (!historyWeekAgo) continue

      const oldPrice = Number(historyWeekAgo.price)
      const newPrice = Number(ing.pricePerUnit)
      if (oldPrice <= 0) continue

      const deltaP = ((newPrice - oldPrice) / oldPrice) * 100
      if (Math.abs(deltaP) > PRICE_SPIKE_THRESHOLD_PERCENT) {
        attention.push({
          type: 'ingredient_price_spike',
          severity: 'medium',
          description: `${ing.name}: цена ${deltaP > 0 ? '+' : ''}${Math.round(deltaP)}% за неделю`,
          relatedData: {
            ingredientId: ing.id,
            ingredientName: ing.name,
            oldPrice,
            newPrice,
            deltaPercent: deltaP,
          },
        })
      }
    }
  }

  // Сортировка severity high → medium → low, слайс до MAX_ATTENTION_ITEMS.
  const severityOrder: Record<AttentionItem['severity'], number> = { high: 0, medium: 1, low: 2 }
  attention.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
  const attentionSliced = attention.slice(0, MAX_ATTENTION_ITEMS)

  // ───────────────────────── TRENDS ─────────────────────────
  const trends: TrendItem[] = []
  if (deltaPercent > 15) {
    trends.push({
      kind: 'volume_up',
      description: `+${Math.round(deltaPercent)}% vs средний день`,
      relatedData: { deltaPercent, avgWeekdayPortions },
    })
  } else if (deltaPercent < -15) {
    trends.push({
      kind: 'volume_down',
      description: `-${Math.abs(Math.round(deltaPercent))}% vs средний день`,
      relatedData: { deltaPercent, avgWeekdayPortions },
    })
  }

  // ───────────────────────── CHARGE CONTEXT ─────────────────────────
  const triggers: string[] = []

  if (deltaPercent > 15) triggers.push('big_volume')
  if (attentionSliced.some((a) => a.type === 'first_delivery')) triggers.push('new_client')
  if (attentionSliced.length >= 3) triggers.push('hard_day')

  // streak_no_complaints — считаем подряд дни без rude/urgent. День = МСК-сутки.
  // Для каждого из последних N+1 дней (включая текущий) проверяем наличие.
  let streak = 0
  for (let offset = 0; offset < 30; offset++) {
    const dayStart = mskMidnightUtc(now, -offset)
    const dayEnd = mskMidnightUtc(now, -offset + 1)
    const alert = await prisma.clientAlertLog.findFirst({
      where: {
        tone: { in: ['rude', 'urgent'] },
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      select: { id: true },
    })
    if (alert) break
    streak++
    if (streak >= STREAK_NO_COMPLAINTS_THRESHOLD_DAYS + 1) break
  }
  if (streak >= STREAK_NO_COMPLAINTS_THRESHOLD_DAYS) triggers.push('streak_no_complaints')

  const chargeContext: ChargeContext | null =
    triggers.length > 0 ? { recommendCharge: true, triggers } : null

  return {
    todayIso,
    tomorrowIso,
    weekdayMsk,
    attention: attentionSliced,
    day: {
      totalPortionsToday,
      pendingConfirmationTomorrow,
      pendingSameDayToday,
      avgWeekdayPortions,
      deltaPercent,
    },
    trends: trends.length > 0 ? trends : null,
    chargeContext,
  }
}
