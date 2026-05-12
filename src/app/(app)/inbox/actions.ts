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
 */
export async function fetchInboxListData(): Promise<InboxClientCard[]> {
  await requireRole(['ADMIN', 'MANAGER'])

  // 1. Уникальные clientId с хотя бы одним BotMessage
  const distinctClients = await prisma.botMessage.findMany({
    select: { clientId: true },
    distinct: ['clientId'],
  })
  const clientIds = distinctClients.map((c) => c.clientId)
  if (clientIds.length === 0) return []

  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: { id: true, name: true, maxUsername: true },
  })

  // 2. Enrich: последнее сообщение + счётчик непрочитанных + последний InboxItem
  const enriched = await Promise.all(
    clients.map(async (c) => {
      const [lastMessage, unreadCount, latestInbox] = await Promise.all([
        prisma.botMessage.findFirst({
          where: { clientId: c.id },
          orderBy: { createdAt: 'desc' },
          select: { text: true, direction: true, createdAt: true },
        }),
        prisma.botMessage.count({
          where: { clientId: c.id, direction: 'IN', readAt: null },
        }),
        prisma.inboxItem.findFirst({
          where: { clientId: c.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
      ])
      return {
        clientId: c.id,
        clientName: c.name,
        maxUsername: c.maxUsername,
        lastMessage: lastMessage
          ? {
              text: lastMessage.text,
              direction: lastMessage.direction,
              createdAt: lastMessage.createdAt.toISOString(),
            }
          : null,
        unreadCount,
        latestInboxItemId: latestInbox?.id ?? null,
      } satisfies InboxClientCard
    })
  )

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

  // Все BotMessage клиента за 7 дней — см. комментарий в inbox/[id]/page.tsx.
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

  // Все BotMessage клиента за 7 дней — см. комментарий в inbox/[id]/page.tsx.
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

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: { draftReply: draft },
  })

  revalidatePath(`/inbox/${inboxItemId}`)
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
    await sendBotMessage(item.client.maxChatId, textToSend)
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
  revalidatePath(`/inbox/${inboxItemId}`)
  return { ok: true, data: undefined }
}

/**
 * @deprecated С 5.4d непрочитанность считается по BotMessage.readAt.
 * Помечает InboxItem как READ — оставлено для совместимости, не вызывается из UI.
 */
export async function markInboxItemRead(
  inboxItemId: string
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const item = await prisma.inboxItem.findUnique({ where: { id: inboxItemId } })
  if (!item) return { ok: false, error: 'Не найден' }
  if (item.status === 'READ') return { ok: true, data: undefined }

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: {
      status: 'READ',
      resolvedAt: new Date(),
      resolvedById: user.id,
    },
  })

  revalidatePath('/inbox')
  revalidatePath(`/inbox/${inboxItemId}`)
  return { ok: true, data: undefined }
}

/**
 * @deprecated С 5.4a inbox-модель = «непрочитано/прочитано». Закрытие
 * без ответа сводится к markInboxItemRead. Оставлен для совместимости
 * до 5.4b, после чего будет удалён вместе с кнопкой в UI.
 */
export async function resolveWithoutReply(
  inboxItemId: string
): Promise<ActionResult> {
  return markInboxItemRead(inboxItemId)
}

/**
 * @deprecated С 5.4d UI кнопки «Открыть заново» нет — тред живёт постоянно,
 * читается через polling. Оставлено для совместимости.
 */
export async function reopenInboxItem(
  inboxItemId: string
): Promise<ActionResult> {
  await requireRole(['ADMIN', 'MANAGER'])

  const item = await prisma.inboxItem.findUnique({ where: { id: inboxItemId } })
  if (!item) return { ok: false, error: 'Не найден' }

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: {
      status: 'UNREAD',
      resolvedAt: null,
      resolvedById: null,
    },
  })

  if (item.conversationId) {
    await prisma.botConversation.update({
      where: { id: item.conversationId },
      data: { status: 'AWAITING_MANAGER' },
    })
  }

  revalidatePath('/inbox')
  revalidatePath(`/inbox/${inboxItemId}`)
  return { ok: true, data: undefined }
}
