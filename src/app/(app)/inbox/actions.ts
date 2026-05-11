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
 * Лениво генерирует draftReply (если его ещё нет) и возвращает его.
 * Идемпотентно: повторный вызов вернёт сохранённый draft, не дёргая LLM повторно.
 */
export async function ensureDraftReply(
  inboxItemId: string
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
  if (item.draftReply) {
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
 * Отправляет ответ клиенту в MAX, закрывает InboxItem (RESOLVED_SENT)
 * и BotConversation (CONFIRMED). customText = редактированный текст из textarea
 * (если null — берём draftReply из БД).
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
      status: 'RESOLVED_SENT',
      resolvedAt: new Date(),
      resolvedById: user.id,
      managerReply: textToSend,
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
 * Закрыть без ответа (RESOLVED_IGNORED) — менеджер ответил вне CRM.
 */
export async function resolveWithoutReply(
  inboxItemId: string
): Promise<ActionResult> {
  const user = await requireRole(['ADMIN', 'MANAGER'])

  const item = await prisma.inboxItem.findUnique({ where: { id: inboxItemId } })
  if (!item) return { ok: false, error: 'Не найден' }

  await prisma.inboxItem.update({
    where: { id: inboxItemId },
    data: {
      status: 'RESOLVED_IGNORED',
      resolvedAt: new Date(),
      resolvedById: user.id,
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
 * Откатить закрытый — снова OPEN.
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
      status: 'OPEN',
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
