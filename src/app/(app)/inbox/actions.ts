'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db/prisma'
import { requireRole } from '@/lib/auth/current-user'
import { generateDraftReply } from '@/lib/llm/draft-generator'
import { sendBotMessage } from '@/lib/max/send-message'
import { logBotMessage } from '@/lib/bot/log-message'

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export interface InboxClientCard {
  clientId: string
  clientName: string
  maxUsername: string | null
  lastMessage: {
    text: string
    direction: 'IN' | 'OUT' | 'MANAGER_OUT'
    createdAt: string
  } | null
  unreadCount: number
  latestInboxItemId: string | null
}

/**
 * Список клиентов с историей переписки. Сортировка по времени последнего сообщения.
 * Используется и в page.tsx (initial render), и в InboxList polling.
 *
 * 6.2: переписано на 4 batched-запроса вместо 2 + 3×N (N+1 был на 50 клиентах).
 * Каждый под-запрос идёт по списку clientIds — пагинация в БД, без map+Promise.all.
 */
export async function fetchInboxListData(): Promise<InboxClientCard[]> {
  await requireRole(['ADMIN', 'MANAGER'])

  const distinctClients = await prisma.botMessage.findMany({
    select: { clientId: true },
    distinct: ['clientId'],
  })
  const clientIds = distinctClients.map((c) => c.clientId)
  if (clientIds.length === 0) return []

  const [clients, lastMessages, unreadGroups, latestInboxItems] = await Promise.all([
    prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, name: true, maxUsername: true },
    }),
    // distinct + orderBy(clientId, createdAt desc) — последнее сообщение каждого клиента
    prisma.botMessage.findMany({
      where: { clientId: { in: clientIds } },
      orderBy: [{ clientId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['clientId'],
      select: { clientId: true, text: true, direction: true, createdAt: true },
    }),
    prisma.botMessage.groupBy({
      by: ['clientId'],
      where: { clientId: { in: clientIds }, direction: 'IN', readAt: null },
      _count: { _all: true },
    }),
    prisma.inboxItem.findMany({
      where: { clientId: { in: clientIds } },
      orderBy: [{ clientId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['clientId'],
      select: { clientId: true, id: true },
    }),
  ])

  const lastMsgByClient = new Map(lastMessages.map((m) => [m.clientId, m]))
  const unreadByClient = new Map(unreadGroups.map((g) => [g.clientId, g._count._all]))
  const latestInboxByClient = new Map(latestInboxItems.map((i) => [i.clientId, i.id]))

  const enriched: InboxClientCard[] = clients.map((c) => {
    const lm = lastMsgByClient.get(c.id)
    return {
      clientId: c.id,
      clientName: c.name,
      maxUsername: c.maxUsername,
      lastMessage: lm
        ? {
            text: lm.text,
            direction: lm.direction,
            createdAt: lm.createdAt.toISOString(),
          }
        : null,
      unreadCount: unreadByClient.get(c.id) ?? 0,
      latestInboxItemId: latestInboxByClient.get(c.id) ?? null,
    }
  })

  enriched.sort((a, b) => {
    const aDate = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : 0
    const bDate = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : 0
    return bDate - aDate
  })

  return enriched
}

/** Server action wrapper для polling из клиентского компонента. */
export async function fetchInboxListFresh(): Promise<InboxClientCard[] | null> {
  try {
    return await fetchInboxListData()
  } catch (err) {
    console.error('[inbox] fetchInboxListFresh failed:', err)
    return null
  }
}

export interface ClientThreadFresh {
  activeItem: {
    id: string
    status: 'UNREAD' | 'READ'
    draftReply: string | null
    clientMessage: string | null
  } | null
  messages: Array<{
    id: string
    direction: 'IN' | 'OUT' | 'MANAGER_OUT'
    text: string
    createdAt: string
    toneLabel: string | null
  }>
}

/**
 * Polling-эндпоинт для /inbox/[clientId]: свежий тред + текущий «активный»
 * InboxItem (последний UNREAD или просто последний). Помечает входящие
 * IN-сообщения этого клиента как прочитанные.
 */
export async function fetchClientThreadFresh(
  clientId: string
): Promise<ActionResult<ClientThreadFresh>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Активный InboxItem = последний UNREAD; если все READ — самый свежий.
  const activeItem = await prisma.inboxItem.findFirst({
    where: { clientId, status: 'UNREAD' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, draftReply: true, clientMessage: true },
  }) ?? await prisma.inboxItem.findFirst({
    where: { clientId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, draftReply: true, clientMessage: true },
  })

  const messages = await prisma.botMessage.findMany({
    where: { clientId, createdAt: { gte: sevenDaysAgo } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, direction: true, text: true, createdAt: true, toneLabel: true },
  })

  await prisma.botMessage.updateMany({
    where: { clientId, direction: 'IN', readAt: null },
    data: { readAt: new Date() },
  })

  return {
    ok: true,
    data: {
      activeItem: activeItem
        ? {
            id: activeItem.id,
            status: activeItem.status,
            draftReply: activeItem.draftReply,
            clientMessage: activeItem.clientMessage,
          }
        : null,
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt.toISOString(),
        toneLabel: m.toneLabel,
      })),
    },
  }
}

/**
 * Возвращает «свежее» состояние InboxItem + сообщения за последние 7 дней
 * для polling из клиентского компонента. Без revalidation — это read-only.
 */
export async function fetchInboxItemFresh(
  inboxItemId: string
): Promise<ActionResult<{
  item: {
    id: string
    status: 'UNREAD' | 'READ'
    draftReply: string | null
    clientMessage: string | null
  }
  messages: Array<{
    id: string
    direction: 'IN' | 'OUT' | 'MANAGER_OUT'
    text: string
    createdAt: string
    toneLabel: string | null
  }>
}>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const item = await prisma.inboxItem.findUnique({
    where: { id: inboxItemId },
    select: {
      id: true,
      clientId: true,
      status: true,
      draftReply: true,
      clientMessage: true,
    },
  })
  if (!item) return { ok: false, error: 'Не найден' }

  // Все BotMessage клиента за 7 дней — см. комментарий в inbox/[clientId]/page.tsx.
  // Не фильтруем по conversationId, чтобы захватить OUT-сообщения cron'а
  // 5.7a, живущие в отдельной PENDING-conv для следующего активного дня.
  const messages = await prisma.botMessage.findMany({
    where: { clientId: item.clientId, createdAt: { gte: sevenDaysAgo } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, direction: true, text: true, createdAt: true, toneLabel: true },
  })

  // Если за время открытой страницы клиент дописал что-то — помечаем как прочитанное
  await prisma.botMessage.updateMany({
    where: {
      clientId: item.clientId,
      direction: 'IN',
      readAt: null,
    },
    data: { readAt: new Date() },
  })

  return {
    ok: true,
    data: {
      item: {
        id: item.id,
        status: item.status,
        draftReply: item.draftReply,
        clientMessage: item.clientMessage,
      },
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt.toISOString(),
        toneLabel: m.toneLabel,
      })),
    },
  }
}

/**
 * Лениво генерирует draftReply (если его ещё нет) и возвращает его.
 * options.force = true — регенерит даже если в БД уже есть draftReply.
 */
export async function ensureDraftReply(
  inboxItemId: string,
  options?: { force?: boolean }
): Promise<ActionResult<{ draft: string }>> {
  await requireRole(['ADMIN', 'MANAGER'])

  const item = await prisma.inboxItem.findUnique({
    where: { id: inboxItemId },
    include: {
      client: { select: { id: true, name: true } },
    },
  })
  if (!item) return { ok: false, error: 'Inbox item не найден' }
  if (item.draftReply && !options?.force) {
    return { ok: true, data: { draft: item.draftReply } }
  }

  // Все BotMessage клиента за 7 дней — см. комментарий в inbox/[clientId]/page.tsx.
  // LLM должен видеть и наш OUT-вопрос cron'а 5.7a, и спонтанные сообщения клиента,
  // независимо от того в какой BotConversation они физически живут.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const conversationMessages = await prisma.botMessage.findMany({
    where: { clientId: item.client.id, createdAt: { gte: sevenDaysAgo } },
    orderBy: { createdAt: 'asc' },
    select: { direction: true, text: true, createdAt: true },
  })

  const messages = conversationMessages.length
    ? conversationMessages
    : item.clientMessage
      ? [{ direction: 'IN' as const, text: item.clientMessage, createdAt: item.createdAt }]
      : []

  if (messages.length === 0) {
    return { ok: false, error: 'Нет сообщений для генерации draft' }
  }

  let draft: string
  try {
    draft = await generateDraftReply({
      clientName: item.client.name,
      clientMessages: messages,
      conversationContext: item.humanReason ?? undefined,
    })
  } catch (e) {
    return { ok: false, error: `LLM error: ${(e as Error).message}` }
  }

  const updated = await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: { draftReply: draft },
    select: { clientId: true },
  })

  revalidatePath(`/inbox/${updated.clientId}`)
  return { ok: true, data: { draft } }
}

/**
 * Отправляет ответ клиенту в MAX, помечает InboxItem как READ,
 * закрывает BotConversation (CONFIRMED). draftReply очищается —
 * следующее сообщение клиента создаст новую UNREAD-карточку.
 */
export async function sendReplyAndResolve(
  inboxItemId: string,
  customText: string | null
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const item = await prisma.inboxItem.findUnique({
    where: { id: inboxItemId },
    include: { client: { select: { id: true, maxChatId: true } } },
  })
  if (!item) return { ok: false, error: 'Inbox item не найден' }

  const textToSend = (customText ?? item.draftReply ?? '').trim()
  if (!textToSend) return { ok: false, error: 'Текст ответа пуст' }

  if (!item.client.maxChatId) {
    return { ok: false, error: 'У клиента не задан maxChatId' }
  }

  try {
    // delay: false — manager уже написал ответ вручную в UI; имитировать
    // «бот печатает» 15-30 сек нет смысла, а server-action блокировался бы
    // и упирался в Vercel function timeout (Hobby = 10 сек).
    await sendBotMessage(item.client.maxChatId, textToSend, { delay: false })
  } catch (e) {
    return { ok: false, error: `Ошибка отправки в MAX: ${(e as Error).message}` }
  }

  await logBotMessage({
    clientId: item.clientId,
    conversationId: item.conversationId,
    direction: 'MANAGER_OUT',
    text: textToSend,
  })

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: {
      status: 'READ',
      resolvedAt: new Date(),
      resolvedById: user.id,
      managerReply: textToSend,
      draftReply: null,
    },
  })

  if (item.conversationId) {
    await prisma.botConversation.update({
      where: { id: item.conversationId },
      data: { status: 'CONFIRMED' },
    })
  }

  revalidatePath('/inbox')
  revalidatePath(`/inbox/${item.clientId}`)
  return { ok: true, data: undefined }
}

