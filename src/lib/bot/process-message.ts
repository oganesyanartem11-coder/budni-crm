import { prisma } from '@/lib/db/prisma'
import { findClientByMaxChatId, findLatestBotConv } from '@/lib/db/queries/bot'
import { parseClientResponse } from '@/lib/llm/parser'
import { detectAnomalies } from '@/lib/orders/anomaly-detector'
import { getClientStats } from '@/lib/orders/client-stats'
import { isPastCutoff } from '@/lib/orders/cutoff'
import { saveBotOrders } from './save-orders'
import { createInboxItem } from './create-inbox-item'
import { notifyManagersAboutInboxItem } from './notify-managers'
import { logBotMessage } from './log-message'
import {
  formatAcceptedReply,
  formatUpdatedReply,
  POST_CUTOFF_REPLY,
  type SavedItemForReply,
} from './templates'
import { sendBotMessage } from '@/lib/max/send-message'
import { NEW_CLIENT_SAFE_STREAK } from '@/lib/orders/anomaly-constants'
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

  const botConv = await findLatestBotConv(client.id)
  if (botConv) {
    return handleBotResponse(client, botConv, text)
  }
  return handleSpontaneous(client, text)
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

    await notifyManagersAboutInboxItem(inbox.id).catch((e) => {
      console.error('[bot] notifyManagers failed:', e)
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
  })

  await prisma.client.update({
    where: { id: client.id },
    data: { safeAnswerStreak: { increment: 1 } },
  })

  const afterCutoff = isPastCutoff(conv.deliveryDate)
  const wasFirstAnswer = conv.status === 'PENDING'

  const itemsForReply: SavedItemForReply[] = save.savedItems.map((s) => ({
    locationName: s.locationName,
    portions: s.portions,
  }))

  if (afterCutoff) {
    // КЕЙС C — после 18:00 МСК. Заказ создан/обновлён, но клиент должен знать
    // что это вне cutoff. InboxItem c POST_CUTOFF, push менеджеру.
    if (conv.status !== 'CONFIRMED') {
      await prisma.botConversation.update({
        where: { id: conv.id },
        data: { status: 'CONFIRMED' },
      })
    }

    await sendBotMessage(client.maxChatId!, POST_CUTOFF_REPLY)
    await logBotMessage({
      clientId: client.id,
      conversationId: conv.id,
      direction: 'OUT',
      text: POST_CUTOFF_REPLY,
    })

    const inbox = await createInboxItem({
      clientId: client.id,
      conversationId: conv.id,
      reason: 'POST_CUTOFF',
      humanReason: 'Клиент ответил после 18:00 — заказ принят, но менеджер может скорректировать',
      priority: 'NORMAL',
      clientMessage: text,
      parsedJson: parsed as unknown as Prisma.InputJsonValue,
    })
    await notifyManagersAboutInboxItem(inbox.id).catch((e) => {
      console.error('[bot] notifyManagers failed:', e)
    })

    return { reply: POST_CUTOFF_REPLY, action: 'post_cutoff', inboxItemId: inbox.id }
  }

  if (wasFirstAnswer) {
    // КЕЙС A — первый ответ до 18:00. Без инбокса.
    await prisma.botConversation.update({
      where: { id: conv.id },
      data: { status: 'CONFIRMED' },
    })

    const reply = formatAcceptedReply(itemsForReply, conv.deliveryDate)
    await sendBotMessage(client.maxChatId!, reply)
    await logBotMessage({
      clientId: client.id,
      conversationId: conv.id,
      direction: 'OUT',
      text: reply,
    })

    return { reply, action: 'saved' }
  }

  // КЕЙС B — conv уже CONFIRMED, клиент пишет повторно, до 18:00.
  // ВАЖНО: схема InboxItemReason не содержит ORDER_UPDATED (см. отчёт 5.7b ШАГ 1).
  // По решению пользователя переиспользуем ANOMALY_HISTORICAL — семантически
  // ближе всего («изменение vs историческое значение»). UI-метка в /inbox
  // будет «Отклонение от нормы» — humanReason поясняет реальную причину.
  const reply = formatUpdatedReply(itemsForReply, conv.deliveryDate)
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
  await notifyManagersAboutInboxItem(inbox.id).catch((e) => {
    console.error('[bot] notifyManagers failed:', e)
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
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
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

  await logBotMessage({
    clientId: client.id,
    conversationId: conversation.id,
    direction: 'IN',
    text,
  })

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

  await notifyManagersAboutInboxItem(inboxItem.id).catch((e) => {
    console.error('[bot] notifyManagers failed:', e)
  })

  return { reply: null, action: 'inbox', inboxItemId: inboxItem.id }
}
