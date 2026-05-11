import { prisma } from '@/lib/db/prisma'
import { findClientByMaxChatId } from '@/lib/db/queries/bot'
import { parseClientResponse } from '@/lib/llm/parser'
import { detectAnomalies } from '@/lib/orders/anomaly-detector'
import { getClientStats } from '@/lib/orders/client-stats'
import { isPastCutoff } from '@/lib/orders/cutoff'
import { saveBotOrders } from './save-orders'
import { createInboxItem } from './create-inbox-item'
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

  // Ищем активный PENDING-разговор. В 5.3 не будет; в 5.7 будет от cron.
  const activeConversation = await prisma.botConversation.findFirst({
    where: { clientId: client.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  })

  if (!activeConversation) {
    return handleSpontaneous(client.id, text)
  }

  // ─── Ветка с парсером (для 5.7+, в 5.3 не выполняется) ───
  return handleParsed(client, activeConversation.id, activeConversation.deliveryDate, text)
}

// ─────────────────────────────────────────────────────────────────────
// Спонтанное сообщение — нет активного вопроса дня.
// БотConversation НЕ создаём (после 5.3a поля conversationId опциональны).
// ─────────────────────────────────────────────────────────────────────
async function handleSpontaneous(
  clientId: string,
  text: string
): Promise<ProcessMessageResult> {
  await logBotMessage({
    clientId,
    conversationId: null,
    direction: 'IN',
    text,
  })

  const inbox = await createInboxItem({
    clientId,
    conversationId: null,
    reason: 'NON_NUMERIC',
    humanReason: 'Спонтанное сообщение от клиента (нет активного вопроса дня)',
    priority: 'NORMAL',
    clientMessage: text,
  })

  return { reply: null, action: 'inbox', inboxItemId: inbox.id }
}

// ─────────────────────────────────────────────────────────────────────
// Парсинг ответа на дневной вопрос (в 5.3 unreachable, готово к 5.7).
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
