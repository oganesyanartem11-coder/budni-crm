import { prisma } from '@/lib/db/prisma'

/**
 * Boris reorg (волна 2): персист последнего ГРУППОВОГО ответа Бори по чату.
 *
 * shouldRespondInGroup (group-filter.ts) считает дистанцию-окно (20 сообщений)
 * между messageId новой реплики и messageId последнего ответа Бори. Этот модуль
 * хранит/отдаёт последний messageId per tgChatId.
 *
 * Обе функции best-effort: НИКОГДА не бросают — трекинг окна не должен ронять
 * ответ Бори. На ошибке чтения → null (фолбэк на «только прямое упоминание»).
 */

/** messageId последнего ответа Бори в группе, или null (нет записи / ошибка). */
export async function getLastBorisGroupReplyMessageId(
  tgChatId: string
): Promise<number | null> {
  if (!tgChatId) return null
  try {
    const row = await prisma.borisGroupReplyTracker.findUnique({
      where: { tgChatId },
      select: { lastReplyMessageId: true },
    })
    return row?.lastReplyMessageId ?? null
  } catch (err) {
    console.error('[boris:group-reply-tracker] read failed (swallowed):', err)
    return null
  }
}

/** Upsert messageId последнего ответа Бори в группе. Best-effort, не бросает. */
export async function recordBorisGroupReply(
  tgChatId: string,
  messageId: number
): Promise<void> {
  if (!tgChatId || !Number.isFinite(messageId)) return
  try {
    await prisma.borisGroupReplyTracker.upsert({
      where: { tgChatId },
      create: { tgChatId, lastReplyMessageId: messageId },
      update: { lastReplyMessageId: messageId },
    })
  } catch (err) {
    console.error('[boris:group-reply-tracker] write failed (swallowed):', err)
  }
}
