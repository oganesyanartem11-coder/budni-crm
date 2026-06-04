import { prisma } from '@/lib/db/prisma'
import { findClientByMaxChatId, findLatestBotConv } from '@/lib/db/queries/bot'
import { parseClientResponse } from '@/lib/llm/parser'
import { detectAnomalies } from '@/lib/orders/anomaly-detector'
import { getClientStats } from '@/lib/orders/client-stats'
import { getCutoffMoment } from '@/lib/orders/cutoff'
import { getClientCutoffForDate, formatCutoff } from '@/lib/utils/cutoff'
import { saveBotOrders } from './save-orders'
import { createInboxItem } from './create-inbox-item'
import { notifyClientSignal } from './notify-client-signal'
import { classifyMessageTone } from '@/lib/llm/tone-classifier'
import { logBotMessage } from './log-message'
import {
  formatAcceptedReply,
  formatUpdatedReply,
  getPostCutoffReply,
  type SavedItemForReply,
} from './templates'
import { sendBotMessage } from '@/lib/max/send-message'
import { mskMidnightUtc } from '@/lib/bot/daily-summary'
import { NEW_CLIENT_SAFE_STREAK } from '@/lib/orders/anomaly-constants'
import { logBorisEvent, emitLivePost, emitAlertPost } from '@/lib/boris/team-channels'
import { toMskDateString } from '@/lib/utils/msk-window'
import { waitUntil } from '@vercel/functions'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { escapeHtml } from '@/lib/telegram/notify'
import type { BotConversation, MealType, Prisma } from '@prisma/client'

const MEAL_TYPE_RU: Record<MealType, string> = {
  BREAKFAST: 'завтрака',
  LUNCH: 'обеда',
  DINNER: 'ужина',
}

export interface ProcessMessageInput {
  maxChatId: string
  text: string
}

export type ProcessAction =
  | 'saved'
  | 'updated'
  | 'post_cutoff'
  | 'inbox'
  | 'unknown_client'
  | 'empty_message'

export interface ProcessMessageResult {
  reply: string | null
  action: ProcessAction
  inboxItemId?: string
}

// MEGA-3 (П11): окно, в течение которого ручной ответ менеджера «глушит»
// автоответ. Если менеджер писал клиенту вручную (MANAGER_OUT) за последние
// MANAGER_TAKEOVER_MIN минут — мы НЕ отвечаем автоматически, чтобы не
// перебивать живую переписку. Только фиксируем входящее и сигналим в inbox.
const MANAGER_TAKEOVER_MIN = 30

/**
 * Проверяет, ведёт ли сейчас менеджер ручную переписку с клиентом.
 * true → автоответ подавляем. Смотрим самый свежий MANAGER_OUT за 24ч и
 * сравниваем его возраст с порогом MANAGER_TAKEOVER_MIN.
 */
async function isManagerHandling(clientId: string, now: Date = new Date()): Promise<boolean> {
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const lastManagerOut = await prisma.botMessage.findFirst({
    where: {
      clientId,
      direction: 'MANAGER_OUT',
      createdAt: { gte: since24h },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (!lastManagerOut) return false
  const ageMs = now.getTime() - lastManagerOut.createdAt.getTime()
  return ageMs <= MANAGER_TAKEOVER_MIN * 60_000
}

/**
 * Главный обработчик входящего сообщения от MAX.
 *
 * Логика 5.7b:
 * 1. Найти клиента по maxChatId. Нет — молчим.
 * 2. findLatestBotConv: самая свежая PENDING|CONFIRMED conv клиента за 30 дней.
 *    - Есть → ветка PARSER (handleBotResponse): A/B/C/D.
 *    - Нет  → ветка SPONTANEOUS (handleSpontaneous): legacy 5.4, кейс E.
 */
export async function processClientMessage(
  input: ProcessMessageInput
): Promise<ProcessMessageResult> {
  const { maxChatId, text } = input

  if (!text.trim()) {
    return { reply: null, action: 'empty_message' }
  }

  const client = await findClientByMaxChatId(maxChatId)
  if (!client) {
    console.warn(`[bot] unknown maxChatId=${maxChatId}, text="${text.slice(0, 100)}"`)
    return { reply: null, action: 'unknown_client' }
  }

  // MEGA-AUDIT-FIX-1 B1 (D-1+D-10): архивный клиент написал.
  // Сообщение не пишем в conversation, тон не классифицируем, Боря-триггеры не
  // эмитим, InboxItem не создаём. Шлём личный алёрт всем активным ADMIN_PRO с
  // привязанным Telegram — пусть решают, возвращать клиента или нет.
  if (!client.isActive) {
    const adminPros = await prisma.user.findMany({
      where: { role: 'ADMIN_PRO', isActive: true, telegramChatId: { not: null } },
      select: { telegramChatId: true },
    })
    const preview = text.length > 200 ? text.slice(0, 200) + '…' : text
    const msg =
      `🔔 Архивный клиент <b>${escapeHtml(client.name)}</b> написал — может, хочет вернуться?\n\n` +
      `«${escapeHtml(preview)}»`
    await Promise.allSettled(
      adminPros.map((u) =>
        sendTelegramMessage(u.telegramChatId as string, msg, { parseMode: 'HTML' })
      )
    )
    return { reply: null, action: 'unknown_client' }
  }

  // MEGA-3 (П11): guard ручной переписки менеджера. Если менеджер отвечал
  // клиенту вручную (MANAGER_OUT) за последние 30 минут — НЕ автоотвечаем,
  // только фиксируем входящее и сигналим в inbox (менеджер ведёт диалог сам).
  if (await isManagerHandling(client.id)) {
    return handleManagerTakeover(client, text)
  }

  const botConv = await findLatestBotConv(client.id)
  if (botConv) {
    return handleBotResponse(client, botConv, text)
  }
  return handleSpontaneous(client, text)
}

// ─────────────────────────────────────────────────────────────────────
// MEGA-3 (П11): MANAGER-TAKEOVER branch — менеджер сейчас в ручном диалоге.
// Никакого автоответа. Пишем входящее в БД (привязываем к самой свежей conv,
// если есть) и создаём/обновляем InboxItem, чтобы менеджер видел сообщение.
// ─────────────────────────────────────────────────────────────────────
async function handleManagerTakeover(
  client: NonNullable<Awaited<ReturnType<typeof findClientByMaxChatId>>>,
  text: string
): Promise<ProcessMessageResult> {
  console.log(`[bot] manager-takeover: client=${client.id} — автоответ подавлен`)

  // Привязываем входящее к самой свежей conv клиента (любого статуса), если есть.
  const conv = await prisma.botConversation.findFirst({
    where: { clientId: client.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  await logBotMessage({
    clientId: client.id,
    conversationId: conv?.id,
    direction: 'IN',
    text,
  })

  // Дедупим InboxItem по conv (если есть) — менеджер увидит свежий текст.
  const existing = conv
    ? await prisma.inboxItem.findFirst({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'desc' },
      })
    : null

  let inboxItem
  if (existing) {
    inboxItem = await prisma.inboxItem.update({
      where: { id: existing.id },
      data: {
        clientMessage: text,
        status: 'UNREAD',
        resolvedAt: null,
        resolvedById: null,
      },
    })
  } else {
    inboxItem = await createInboxItem({
      clientId: client.id,
      conversationId: conv?.id,
      reason: 'NON_NUMERIC',
      humanReason: 'Сообщение во время ручной переписки менеджера',
      priority: 'NORMAL',
      clientMessage: text,
    })
  }

  return { reply: null, action: 'inbox', inboxItemId: inboxItem.id }
}

// ─────────────────────────────────────────────────────────────────────
// PARSER branch — клиент отвечает на cron-вопрос. Кейсы A/B/C/D.
// ─────────────────────────────────────────────────────────────────────
async function handleBotResponse(
  client: NonNullable<Awaited<ReturnType<typeof findClientByMaxChatId>>>,
  conv: BotConversation,
  text: string
): Promise<ProcessMessageResult> {
  const dayOfWeek = conv.deliveryDate.getUTCDay()
  const stats = await getClientStats(client.id, dayOfWeek)

  const firstMealType = client.locations[0]?.mealConfigs[0]?.mealType ?? 'LUNCH'
  const mealTypeRu = MEAL_TYPE_RU[firstMealType] ?? 'обеда'

  const locationAliases = (client.locationAliases ?? {}) as Record<string, string[]>

  const parsed = await parseClientResponse({
    clientText: text,
    clientName: client.name,
    mealTypeRu,
    locations: client.locations.map((l) => ({
      id: l.id,
      name: l.name,
      aliases: locationAliases[l.id] ?? [],
    })),
    recentOrders: stats.recentOrders.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      locationName: o.locationName,
      portions: o.portions,
    })),
  })

  // IN-сообщение пишем сразу с метаданными парсинга — менеджер в /inbox увидит
  // и сырой текст, и tone/confidence/reason.
  await logBotMessage({
    clientId: client.id,
    conversationId: conv.id,
    direction: 'IN',
    text,
    parsedJson: parsed as unknown as Prisma.InputJsonValue,
    llmConfidence: parsed.confidence,
    llmReason: parsed.reason,
    toneLabel: parsed.toneLabel,
  })

  // 7.16.C.1 hotfix: parseClientResponse даёт неточный tone для нецифровых
  // ответов (Haiku парсер сфокусирован на цифрах, tone — побочное правило).
  // Для не-numeric — переклассифицируем через dedicated classifyMessageTone,
  // тот же что используется в handleSpontaneous. Тон в БД-записи BotMessage
  // оставляем какой дал парсер (для аудита) — переопределяем только
  // бизнес-логику триггеров и алёртов.
  let effectiveTone: typeof parsed.toneLabel = parsed.toneLabel
  if (parsed.type !== 'numeric') {
    try {
      effectiveTone = await classifyMessageTone(text)
    } catch (err) {
      console.error('[boris-team] tone reclassify failed, fallback to parsed.toneLabel', err)
      // effectiveTone остаётся parsed.toneLabel (fail-safe)
    }
  }

  // 7.16.C: триггер Командного Бориса — «спасибо» от клиента.
  // Деduplicate per (client, day) — даже если клиент благодарит дважды за день,
  // в групповой чат уходит максимум один LIVE-пост.
  if (effectiveTone === 'thanks') {
    const today = new Date()
    const yyyymmdd = today.toISOString().slice(0, 10)
    // 7.16.C.2: logBorisEvent — синхронно (быстрый INSERT, гарантия записи в БД
    // даже если MAX-bot composer ломает AsyncLocalStorage для after()).
    // emitLivePost — через waitUntil (низкоуровневый Vercel API, работает в любом
    // async-контексте serverless invocation, не зависит от request scope).
    try {
      const event = await logBorisEvent({
        eventType: 'THANKS',
        eventDate: today,
        clientId: client.id,
        payload: { clientName: client.name, messageExcerpt: text.slice(0, 200) },
        deduplKey: `thanks:${client.id}:${yyyymmdd}`,
      })
      if (event) {
        waitUntil(
          emitLivePost(event).catch((err) =>
            console.error('[boris-team] thanks emit failed', err),
          ),
        )
      }
    } catch (err) {
      console.error('[boris-team] thanks logBorisEvent failed', err)
    }
  }

  // 7.16.C: триггер ALERT — клиент написал «срочно» и у него есть заказ с
  // доставкой в ближайшие 4 часа. timestamp-based deduplKey ОК, потому что
  // дальше всё равно режется логикой findFirst (нет двух заказов одного клиента
  // в одну миллисекунду).
  if (effectiveTone === 'urgent') {
    const now = new Date()
    const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000)
    try {
      const urgentOrder = await prisma.order.findFirst({
        where: {
          clientId: client.id,
          deliveryDate: { gte: now, lte: in4h },
          status: { in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'] },
        },
        select: { id: true, deliveryDate: true, mealType: true },
      })
      if (urgentOrder) {
        const event = await logBorisEvent({
          eventType: 'URGENT_NEAR_DELIVERY',
          eventDate: now,
          clientId: client.id,
          orderId: urgentOrder.id,
          payload: {
            clientName: client.name,
            deliveryDate: urgentOrder.deliveryDate,
            mealType: urgentOrder.mealType,
            messageExcerpt: text.slice(0, 300),
          },
          deduplKey: `urgent:${urgentOrder.id}:${now.getTime()}`,
        })
        if (event) {
          waitUntil(
            emitAlertPost(event).catch((err) =>
              console.error('[boris-team] urgent emit failed', err),
            ),
          )
        }
      }
    } catch (err) {
      console.error('[boris-team] urgent trigger failed', err)
    }
  }

  // 7.16.C.3: триггер RUDE — клиент написал в грубом тоне. В отличие от ALERT
  // (urgent + доставка <4ч), RUDE идёт в LIVE-канал команде с СУТЬЮ жалобы
  // из messageExcerpt. Дедуп 1 пост на клиента в день. Существующий
  // notifyToneRecipients в личку ADMIN_PRO (7.15) продолжает работать рядом.
  if (effectiveTone === 'rude') {
    const today = new Date()
    const yyyymmdd = today.toISOString().slice(0, 10)
    try {
      const event = await logBorisEvent({
        eventType: 'RUDE',
        eventDate: today,
        clientId: client.id,
        payload: { clientName: client.name, messageExcerpt: text.slice(0, 300) },
        deduplKey: `rude:${client.id}:${yyyymmdd}`,
      })
      if (event) {
        waitUntil(
          emitLivePost(event).catch((err) =>
            console.error('[boris-team] rude emit failed', err),
          ),
        )
      }
    } catch (err) {
      console.error('[boris-team] rude logBorisEvent failed', err)
    }
  }

  // 7.15.B: tone-only алёрт (КЕЙС A — заказ принят, но клиент написал rude/urgent)
  // отправляется НИЖЕ перед return-saved. Для КЕЙСОВ C/D алёрт объединён с
  // notifyClientSignal про InboxItem — отдельный tone-вызов не нужен.
  const alertTone =
    effectiveTone === 'rude' || effectiveTone === 'urgent' ? effectiveTone : null

  // Аномалии содержания (без cutoff — cutoff обрабатываем отдельно как кейс C
  // с сохранением заказа). isPastCutoff=false внутри detectAnomalies, чтобы
  // ветвь POST_CUTOFF не перебивала остальные reason'ы.
  const anomaly = detectAnomalies({
    parsed,
    stats,
    isNewClient: client.safeAnswerStreak < NEW_CLIENT_SAFE_STREAK,
    isPastCutoff: false,
  })

  const isNotNumeric = parsed.type !== 'numeric'
  if (anomaly.isAnomaly || isNotNumeric) {
    // КЕЙС D — парсер не понял или аномалия по содержанию. Заказ НЕ сохраняем.
    const reason = anomaly.reason ?? 'NON_NUMERIC'
    const humanReason = anomaly.humanReason || (parsed.reason || 'Не цифровой ответ')

    if (conv.status !== 'AWAITING_MANAGER') {
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { status: 'AWAITING_MANAGER' },
      })
    }

    const inbox = await createInboxItem({
      clientId: client.id,
      conversationId: conv.id,
      reason,
      humanReason,
      priority: anomaly.priority ?? 'NORMAL',
      clientMessage: text,
      parsedJson: parsed as unknown as Prisma.InputJsonValue,
      clientStatsSnapshot: {
        averageByDayOfWeek: stats.averageByDayOfWeek,
        typicalRange: stats.typicalRange,
        sampleSize: stats.sampleSize,
      } as Prisma.InputJsonValue,
    })

    await notifyClientSignal({
      clientId: client.id,
      messageText: text,
      inboxItemId: inbox.id,
      tone: alertTone,
      reason: inbox.reason,
      priority: inbox.priority,
    }).catch((e) => {
      console.error('[bot] notifyClientSignal failed:', e)
    })

    return { reply: null, action: 'inbox', inboxItemId: inbox.id }
  }

  // Парсер вернул число и аномалий нет — сохраняем заказ.
  const activeMealConfigsByLocation: Record<
    string,
    Array<{ mealType: MealType; pricePerPortion: number; locationName: string }>
  > = {}
  for (const loc of client.locations) {
    activeMealConfigsByLocation[loc.id] = loc.mealConfigs.map((c) => ({
      mealType: c.mealType,
      pricePerPortion: Number(c.pricePerPortion),
      locationName: loc.name,
    }))
  }

  const save = await saveBotOrders({
    clientId: client.id,
    conversationId: conv.id,
    deliveryDate: conv.deliveryDate,
    items: parsed.items,
    activeMealConfigsByLocation,
    clientMessage: text,
  })

  // 6.8a: orphan-config escalation удалён — после NOT NULL миграции
  // ClientMealConfig.locationId конфиги без локации больше невозможны.

  await prisma.client.update({
    where: { id: client.id },
    data: { safeAnswerStreak: { increment: 1 } },
  })

  // MEGA-3 (П5+П9): cut-off строго в МСК и с учётом same-day клиентов.
  //
  // П9: для same-day-локации (доставка сегодня) cut-off = индивидуальный
  // (напр. 08:40) на САМ день доставки; для обычных клиентов = 16:00 накануне.
  // getClientCutoffForDate возвращает {hour,minute}, sameDay-флаг определяем
  // тем же признаком (доставка сегодня + есть same-day-локация).
  //
  // П5: момент cut-off считаем через getCutoffMoment (fromZonedTime, МСК) —
  // никаких `now > cutoff` в UTC. До cut-off МСК → нормальный приём
  // (formatAccepted/Updated). После → getPostCutoffReply.
  const now = new Date()
  // Резолвим cut-off по локации(ям) ИМЕННО этого заказа, а не по всем
  // локациям клиента: иначе обычная точка унаследовала бы same-day 08:40
  // от другой точки клиента. Среди локаций заказа выбираем same-day с самым
  // ранним cut-off (ближайший дедлайн для клиента); если same-day среди
  // заказа нет — первую локацию заказа (даст обычный 16:00).
  const deliveryIsToday = toMskDateString(conv.deliveryDate) === toMskDateString(now)
  const orderLocations = save.savedItems
    .map((s) => client.locations.find((l) => l.id === s.locationId))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
  const sameDayOrderLocations = deliveryIsToday
    ? orderLocations.filter((l) => l.sameDayDelivery && l.isActive !== false)
    : []
  const cutoffLocation =
    sameDayOrderLocations.length > 0
      ? sameDayOrderLocations.reduce((a, b) =>
          (a.cutoffHourMsk ?? 16) * 60 + (a.cutoffMinuteMsk ?? 0) <=
          (b.cutoffHourMsk ?? 16) * 60 + (b.cutoffMinuteMsk ?? 0)
            ? a
            : b
        )
      : (orderLocations[0] ?? null)
  const cutoff = getClientCutoffForDate({
    client,
    deliveryDate: conv.deliveryDate,
    locationId: cutoffLocation?.id ?? null,
    now,
  })
  const isSameDayCutoff =
    deliveryIsToday &&
    !!cutoffLocation?.sameDayDelivery &&
    cutoffLocation.isActive !== false
  const cutoffMoment = getCutoffMoment(
    conv.deliveryDate,
    cutoff.hour,
    cutoff.minute,
    isSameDayCutoff
  )
  const afterCutoff = now.getTime() >= cutoffMoment.getTime()
  const cutoffStr = formatCutoff(cutoff)
  const wasFirstAnswer = conv.status === 'PENDING'

  const itemsForReply: SavedItemForReply[] = save.savedItems.map((s) => ({
    locationName: s.locationName,
    portions: s.portions,
  }))

  if (afterCutoff) {
    // КЕЙС C — после 16:00 МСК. Заказ создан/обновлён, но клиент должен знать
    // что это вне cutoff. InboxItem c POST_CUTOFF, push менеджеру (срочно).
    if (conv.status !== 'CONFIRMED') {
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { status: 'CONFIRMED' },
      })
    }

    const postCutoffReply = getPostCutoffReply(cutoffStr)
    await sendBotMessage(client.maxChatId!, postCutoffReply)
    await logBotMessage({
      clientId: client.id,
      conversationId: conv.id,
      direction: 'OUT',
      text: postCutoffReply,
    })

    const inbox = await createInboxItem({
      clientId: client.id,
      conversationId: conv.id,
      reason: 'POST_CUTOFF',
      humanReason: `Клиент ответил после ${cutoffStr} — заказ принят, но менеджер может скорректировать`,
      priority: 'NORMAL',
      clientMessage: text,
      parsedJson: parsed as unknown as Prisma.InputJsonValue,
    })
    await notifyClientSignal({
      clientId: client.id,
      messageText: text,
      inboxItemId: inbox.id,
      tone: alertTone,
      reason: inbox.reason,
      priority: inbox.priority,
    }).catch((e) => {
      console.error('[bot] notifyClientSignal failed:', e)
    })

    return { reply: postCutoffReply, action: 'post_cutoff', inboxItemId: inbox.id }
  }

  if (wasFirstAnswer) {
    // КЕЙС A — первый ответ до 16:00. Заказ принят, в обычной ветке инбокса нет.
    // 7.15.B: если тон rude/urgent — всё равно шлём tone-only алёрт (inboxItemId=null,
    // reason=null). notifyClientSignal сам решит про cooldown.
    await prisma.botConversation.update({
      where: { id: conv.id },
      data: { status: 'CONFIRMED' },
    })

    // 7.39: same-day delivery — для локаций с sameDayDelivery=true утренний
    // заказ зафиксирован, шефу пора в производство. Эмитим SAMEDAY_ORDER_LOCKED
    // в LIVE-канал. savedItems не содержит orderId (см. SaveBotOrdersResult),
    // поэтому добираем order по бизнес-ключу (clientId+locationId+mealType+date).
    // Дедуп по (orderId, день) — повторный CONFIRMED того же заказа не плодит пост.
    const sameDayNow = new Date()
    const sameDayYyyymmdd = toMskDateString(conv.deliveryDate)
    for (const item of save.savedItems) {
      const location = client.locations.find((l) => l.id === item.locationId)
      if (!location?.sameDayDelivery) continue
      try {
        const order = await prisma.order.findFirst({
          where: {
            clientId: client.id,
            locationId: item.locationId,
            mealType: item.mealType,
            deliveryDate: conv.deliveryDate,
            status: { notIn: ['CANCELLED'] },
          },
          select: { id: true },
        })
        if (!order) continue
        const event = await logBorisEvent({
          eventType: 'SAMEDAY_ORDER_LOCKED',
          eventDate: sameDayNow,
          clientId: client.id,
          orderId: order.id,
          payload: {
            clientName: client.name,
            locationName: item.locationName,
            mealType: item.mealType,
            portions: item.portions,
            deliveryDate: sameDayYyyymmdd,
            cutoffHourMsk: location.cutoffHourMsk ?? 16,
            cutoffMinuteMsk: location.cutoffMinuteMsk ?? 0,
          },
          deduplKey: `sameday-locked:${order.id}:${sameDayYyyymmdd}`,
        })
        if (event) {
          waitUntil(
            emitLivePost(event).catch((err) =>
              console.error('[boris-team] sameday-locked emit failed', err),
            ),
          )
        }
      } catch (err) {
        console.error('[boris-team] sameday-locked trigger failed', err)
      }
    }

    const reply = formatAcceptedReply(itemsForReply)
    await sendBotMessage(client.maxChatId!, reply)
    await logBotMessage({
      clientId: client.id,
      conversationId: conv.id,
      direction: 'OUT',
      text: reply,
    })

    if (alertTone) {
      await notifyClientSignal({
        clientId: client.id,
        messageText: text,
        inboxItemId: null,
        tone: alertTone,
        reason: null,
        priority: null,
      }).catch((e) => {
        console.error('[bot] notifyClientSignal failed (saved-with-tone):', e)
      })
    }

    return { reply, action: 'saved' }
  }

  // КЕЙС B — conv уже CONFIRMED, клиент пишет повторно, до 16:00.
  // InboxItem создаём (чтобы менеджер видел изменение в /inbox), но БЕЗ push'а
  // в MAX — повтор не срочный, увидим в следующей сводке.
  // NB: схема InboxItemReason не содержит ORDER_UPDATED — используем
  // ANOMALY_HISTORICAL (решение пользователя). UI-метка «Отклонение от нормы».
  const reply = formatUpdatedReply(itemsForReply)
  await sendBotMessage(client.maxChatId!, reply)
  await logBotMessage({
    clientId: client.id,
    conversationId: conv.id,
    direction: 'OUT',
    text: reply,
  })

  const inbox = await createInboxItem({
    clientId: client.id,
    conversationId: conv.id,
    reason: 'ANOMALY_HISTORICAL',
    humanReason: 'Клиент изменил уже подтверждённый заказ',
    priority: 'NORMAL',
    clientMessage: text,
    parsedJson: parsed as unknown as Prisma.InputJsonValue,
  })

  return { reply, action: 'updated', inboxItemId: inbox.id }
}

// ─────────────────────────────────────────────────────────────────────
// SPONTANEOUS branch — кейс E. Legacy 5.4 логика.
// ─────────────────────────────────────────────────────────────────────
async function handleSpontaneous(
  client: NonNullable<Awaited<ReturnType<typeof findClientByMaxChatId>>>,
  text: string
): Promise<ProcessMessageResult> {
  // Ищем существующую spontaneous conv (НЕ PENDING/CONFIRMED — те мы уже исключили).
  // Берём последнюю по createdAt: AWAITING_MANAGER продолжаем, EXPIRED/CANCELLED
  // переоткрываем как новый тред.
  let conversation = await prisma.botConversation.findFirst({
    where: { clientId: client.id, status: { notIn: ['PENDING', 'CONFIRMED'] } },
    orderBy: { createdAt: 'desc' },
  })

  let isReopenedConversation = false
  if (!conversation) {
    // 7.11/F-1: deliveryDate должен быть «MSK-полночь сегодня как UTC-точка»,
    // иначе на серверах в UTC (Vercel) между 21:00 и 24:00 МСК он сваливался
    // в следующий календарный день и ломал @@unique([clientId, deliveryDate]).
    const today = mskMidnightUtc(new Date(), 0)
    try {
      conversation = await prisma.botConversation.create({
        data: { clientId: client.id, deliveryDate: today, status: 'AWAITING_MANAGER' },
      })
    } catch (err) {
      // P2002 — race по @@unique([clientId, deliveryDate]). Перечитываем.
      const existing = await prisma.botConversation.findFirst({
        where: { clientId: client.id, deliveryDate: today },
        orderBy: { createdAt: 'desc' },
      })
      if (!existing) throw err
      conversation = existing
    }
  } else if (conversation.status !== 'AWAITING_MANAGER') {
    conversation = await prisma.botConversation.update({
      where: { id: conversation.id },
      data: { status: 'AWAITING_MANAGER' },
    })
    isReopenedConversation = true
  }

  // 7.15 hotfix #2: spontaneous-сообщения тоже классифицируем по тону.
  // parseClientResponse здесь не запускается (нет структуры order'ов для извлечения),
  // поэтому tone из него взять неоткуда. Lightweight classifyMessageTone делает
  // отдельный AI-вызов (tool_use, max_tokens=50), fail-safe → 'neutral' при сбое.
  const spontaneousTone = await classifyMessageTone(text)

  await logBotMessage({
    clientId: client.id,
    conversationId: conversation.id,
    direction: 'IN',
    text,
    toneLabel: spontaneousTone,
  })

  // 7.16.C: триггер Командного Бориса — «спасибо» от клиента (spontaneous-ветка).
  // 7.16.C.2: logBorisEvent синхронно + emit через waitUntil — см. комментарий в handleBotResponse.
  if (spontaneousTone === 'thanks') {
    const today = new Date()
    const yyyymmdd = today.toISOString().slice(0, 10)
    try {
      const event = await logBorisEvent({
        eventType: 'THANKS',
        eventDate: today,
        clientId: client.id,
        payload: { clientName: client.name, messageExcerpt: text.slice(0, 200) },
        deduplKey: `thanks:${client.id}:${yyyymmdd}`,
      })
      if (event) {
        waitUntil(
          emitLivePost(event).catch((err) =>
            console.error('[boris-team] thanks emit failed', err),
          ),
        )
      }
    } catch (err) {
      console.error('[boris-team] thanks logBorisEvent failed', err)
    }
  }

  // 7.16.C: триггер ALERT — urgent + заказ с доставкой в ближайшие 4 часа.
  if (spontaneousTone === 'urgent') {
    const now = new Date()
    const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000)
    try {
      const urgentOrder = await prisma.order.findFirst({
        where: {
          clientId: client.id,
          deliveryDate: { gte: now, lte: in4h },
          status: { in: ['CONFIRMED', 'LOCKED', 'IN_PRODUCTION', 'OUT_FOR_DELIVERY'] },
        },
        select: { id: true, deliveryDate: true, mealType: true },
      })
      if (urgentOrder) {
        const event = await logBorisEvent({
          eventType: 'URGENT_NEAR_DELIVERY',
          eventDate: now,
          clientId: client.id,
          orderId: urgentOrder.id,
          payload: {
            clientName: client.name,
            deliveryDate: urgentOrder.deliveryDate,
            mealType: urgentOrder.mealType,
            messageExcerpt: text.slice(0, 300),
          },
          deduplKey: `urgent:${urgentOrder.id}:${now.getTime()}`,
        })
        if (event) {
          waitUntil(
            emitAlertPost(event).catch((err) =>
              console.error('[boris-team] urgent emit failed', err),
            ),
          )
        }
      }
    } catch (err) {
      console.error('[boris-team] urgent trigger failed', err)
    }
  }

  // 7.16.C.3: триггер RUDE — клиент в грубом тоне → LIVE-канал с сутью жалобы.
  // Симметрично handleBotResponse. notifyClientSignal ниже продолжает слать
  // личный tone-алёрт в Telegram ADMIN_PRO (старое поведение 7.15).
  if (spontaneousTone === 'rude') {
    const today = new Date()
    const yyyymmdd = today.toISOString().slice(0, 10)
    try {
      const event = await logBorisEvent({
        eventType: 'RUDE',
        eventDate: today,
        clientId: client.id,
        payload: { clientName: client.name, messageExcerpt: text.slice(0, 300) },
        deduplKey: `rude:${client.id}:${yyyymmdd}`,
      })
      if (event) {
        waitUntil(
          emitLivePost(event).catch((err) =>
            console.error('[boris-team] rude emit failed', err),
          ),
        )
      }
    } catch (err) {
      console.error('[boris-team] rude logBorisEvent failed', err)
    }
  }

  // 7.15.B: tone-сигнал шлём вместе с inbox-сигналом ниже через notifyClientSignal.
  const spontaneousAlertTone =
    spontaneousTone === 'rude' || spontaneousTone === 'urgent' ? spontaneousTone : null

  // Дедупим InboxItem по conv. Reopened → новый item.
  let inboxItem = isReopenedConversation
    ? null
    : await prisma.inboxItem.findFirst({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
      })

  if (!inboxItem) {
    inboxItem = await createInboxItem({
      clientId: client.id,
      conversationId: conversation.id,
      reason: 'NON_NUMERIC',
      humanReason: 'Спонтанное сообщение от клиента',
      priority: 'NORMAL',
      clientMessage: text,
    })
  } else {
    await prisma.inboxItem.update({
      where: { id: inboxItem.id },
      data: {
        clientMessage: text,
        draftReply: null,
        lastPushedAt: null,
        resolvedAt: null,
        resolvedById: null,
      },
    })
  }

  await notifyClientSignal({
    clientId: client.id,
    messageText: text,
    inboxItemId: inboxItem.id,
    tone: spontaneousAlertTone,
    reason: inboxItem.reason,
    priority: inboxItem.priority,
  }).catch((e) => {
    console.error('[bot] notifyClientSignal failed (spontaneous):', e)
  })

  return { reply: null, action: 'inbox', inboxItemId: inboxItem.id }
}
