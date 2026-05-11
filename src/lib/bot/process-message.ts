import { prisma } from '@/lib/db/prisma'
import { findClientByMaxChatId } from '@/lib/db/queries/bot'
import { parseClientResponse } from '@/lib/llm/parser'
import { detectAnomalies } from '@/lib/orders/anomaly-detector'
import { getClientStats } from '@/lib/orders/client-stats'
import { isPastCutoff } from '@/lib/orders/cutoff'
import { saveBotOrders } from './save-orders'
import { createInboxItem } from './create-inbox-item'
import { notifyManagersAboutInboxItem } from './notify-managers'
import { logBotMessage } from './log-message'
import { getBotReplyTemplate, type ReplyTemplateKey } from './templates'
import { NEW_CLIENT_SAFE_STREAK } from '@/lib/orders/anomaly-constants'
import type { MealType, Prisma } from '@prisma/client'

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
  | 'inbox'
  | 'unknown_client'
  | 'empty_message'

export interface ProcessMessageResult {
  reply: string | null
  action: ProcessAction
  inboxItemId?: string
}

/**
 * Главный обработчик входящего сообщения от MAX.
 *
 * Логика 5.3:
 * 1. Найти клиента по maxChatId (если нет — молчим, логируем).
 * 2. Найти активную BotConversation (status=PENDING). В 5.3 её никогда нет
 *    (создаётся cron'ом в 5.7), значит ВСЕ сообщения уходят как «спонтанные»
 *    → синтетическая BotConversation на сегодня (status=AWAITING_MANAGER),
 *    InboxItem с reason=NON_NUMERIC, BotMessage(direction=IN), бот молчит.
 *
 * Ветка с парсером (для 5.7+) написана, но не достижима в 5.3.
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

  // Тред дня: BotConversation за СЕГОДНЯ (UTC midnight).
  // Schema имеет @@unique([clientId, deliveryDate]) — на (клиент, день) максимум
  // одна conversation. Поэтому ищем БЕЗ фильтра по статусу, а потом решаем:
  //  - PENDING → парсер (5.7+)
  //  - AWAITING_MANAGER → продолжаем тот же inbox-item
  //  - CONFIRMED/EXPIRED/CANCELLED → conv был закрыт менеджером,
  //    «reopen» — переводим обратно в AWAITING_MANAGER и СОЗДАЁМ НОВЫЙ inbox-item
  //    (для менеджера это визуально новый тред).
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  let conversation = await prisma.botConversation.findFirst({
    where: { clientId: client.id, deliveryDate: today },
    orderBy: { createdAt: 'desc' },
  })

  let isReopenedConversation = false
  if (!conversation) {
    conversation = await prisma.botConversation.create({
      data: {
        clientId: client.id,
        deliveryDate: today,
        status: 'AWAITING_MANAGER',
      },
    })
  } else if (
    conversation.status === 'CONFIRMED' ||
    conversation.status === 'EXPIRED' ||
    conversation.status === 'CANCELLED'
  ) {
    conversation = await prisma.botConversation.update({
      where: { id: conversation.id },
      data: { status: 'AWAITING_MANAGER' },
    })
    isReopenedConversation = true
  }

  // PENDING — ответ на cron-вопрос дня → парсер (5.7+) сам залогирует с parsedJson
  if (conversation.status === 'PENDING') {
    return handleParsed(client, conversation.id, conversation.deliveryDate, text)
  }

  // AWAITING_MANAGER — спонтанное общение. Логируем без parsedJson.
  await logBotMessage({
    clientId: client.id,
    conversationId: conversation.id,
    direction: 'IN',
    text,
  })

  // Дедупим InboxItem по conversation. Если conv только что переоткрыт после
  // закрытия — это НОВЫЙ тред с точки зрения менеджера, создаём новый item.
  // Иначе берём последний item: открытый продолжаем, прочитанный — возвращаем
  // в UNREAD и сбрасываем устаревший draft.
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
    // Новое сообщение в треде: обновляем превью, сбрасываем draft и cooldown
    // пушей (это свежее событие). status: 'UNREAD' НЕ ставим — с 5.4d
    // непрочитанность считается по BotMessage.readAt.
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

  // Push менеджерам. Раньше был fire-and-forget — но на serverless (Vercel)
  // функция может завершиться до резолва промиса. С await серверный handler
  // ждёт отправку перед возвратом MAX-у.
  await notifyManagersAboutInboxItem(inboxItem.id).catch((e) => {
    console.error('[bot] notifyManagers failed:', e)
  })

  return { reply: null, action: 'inbox', inboxItemId: inboxItem.id }
}

// ─────────────────────────────────────────────────────────────────────
// Парсинг ответа на дневной вопрос (в 5.3-5.4 unreachable, готово к 5.7).
// ─────────────────────────────────────────────────────────────────────
async function handleParsed(
  client: NonNullable<Awaited<ReturnType<typeof findClientByMaxChatId>>>,
  conversationId: string,
  deliveryDate: Date,
  text: string
): Promise<ProcessMessageResult> {
  const dayOfWeek = deliveryDate.getUTCDay()
  const stats = await getClientStats(client.id, dayOfWeek)

  // Каноническое название первого активного meal-конфига для подсказки LLM
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

  const anomaly = detectAnomalies({
    parsed,
    stats,
    isNewClient: client.safeAnswerStreak < NEW_CLIENT_SAFE_STREAK,
    isPastCutoff: isPastCutoff(deliveryDate),
  })

  if (anomaly.isAnomaly) {
    await logBotMessage({
      clientId: client.id,
      conversationId,
      direction: 'IN',
      text,
      parsedJson: parsed as unknown as Prisma.InputJsonValue,
      llmConfidence: parsed.confidence,
      llmReason: parsed.reason,
      toneLabel: parsed.toneLabel,
    })

    const inbox = await createInboxItem({
      clientId: client.id,
      conversationId,
      reason: anomaly.reason!,
      humanReason: anomaly.humanReason,
      priority: anomaly.priority,
      clientMessage: text,
      parsedJson: parsed as unknown as Prisma.InputJsonValue,
      clientStatsSnapshot: {
        averageByDayOfWeek: stats.averageByDayOfWeek,
        typicalRange: stats.typicalRange,
        sampleSize: stats.sampleSize,
      } as Prisma.InputJsonValue,
    })

    await prisma.botConversation.update({
      where: { id: conversationId },
      data: { status: 'AWAITING_MANAGER' },
    })

    await notifyManagersAboutInboxItem(inbox.id).catch((e) => {
      console.error('[bot] notifyManagers failed:', e)
    })

    return { reply: null, action: 'inbox', inboxItemId: inbox.id }
  }

  // Всё ок — сохраняем заказы
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
    conversationId,
    deliveryDate,
    items: parsed.items,
    activeMealConfigsByLocation,
  })

  await prisma.client.update({
    where: { id: client.id },
    data: { safeAnswerStreak: { increment: 1 } },
  })

  await prisma.botConversation.update({
    where: { id: conversationId },
    data: { status: 'CONFIRMED' },
  })

  await logBotMessage({
    clientId: client.id,
    conversationId,
    direction: 'IN',
    text,
    parsedJson: parsed as unknown as Prisma.InputJsonValue,
    llmConfidence: parsed.confidence,
    llmReason: parsed.reason,
    toneLabel: parsed.toneLabel,
  })

  const replyKey: ReplyTemplateKey = save.wasUpdate ? 'UPDATED' : 'ACCEPTED'
  const reply = getBotReplyTemplate(replyKey, {
    items: save.savedItems.map((s) => ({ locationName: s.locationName, portions: s.portions })),
    deliveryDate,
  })

  return { reply, action: save.wasUpdate ? 'updated' : 'saved' }
}
