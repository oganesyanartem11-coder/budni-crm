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
    include: {
      conversation: {
        select: {
          id: true,
          messages: {
            where: { createdAt: { gte: sevenDaysAgo } },
            orderBy: { createdAt: 'asc' },
            select: { id: true, direction: true, text: true, createdAt: true, toneLabel: true },
          },
        },
      },
    },
  })
  if (!item) return { ok: false, error: 'Не найден' }

  return {
    ok: true,
    data: {
      item: {
        id: item.id,
        status: item.status,
        draftReply: item.draftReply,
        clientMessage: item.clientMessage,
      },
      messages: (item.conversation?.messages ?? []).map((m) => ({
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
      conversation: {
        select: {
          id: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            select: { direction: true, text: true, createdAt: true },
          },
        },
      },
    },
  })
  if (!item) return { ok: false, error: 'Inbox item не найден' }
  if (item.draftReply && !options?.force) {
    return { ok: true, data: { draft: item.draftReply } }
  }

  const messages = item.conversation?.messages.length
    ? item.conversation.messages
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
 * Помечает InboxItem как READ при открытии страницы менеджером.
 * Используется UI карточки (5.4b). BotConversation НЕ закрывает — тред живой.
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
 * Возвращает InboxItem в статус UNREAD (если был случайно помечен прочитанным
 * или после отправки ответа менеджер хочет вернуть в работу). Также
 * переоткрывает BotConversation — AWAITING_MANAGER.
 * draftReply не трогаем — менеджер сам решит регенерировать или нет.
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
