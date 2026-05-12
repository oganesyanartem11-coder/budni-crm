import type { InlineKeyboard } from 'grammy'
import { prisma } from '@/lib/db/prisma'
import { sendTelegramMessage } from './send'
import { getTelegramEnv } from './env'

export interface NotifyOptions {
  /** Если не указан — текст шлётся без parseMode (как plain text). */
  parseMode?: 'HTML' | 'MarkdownV2'
  replyMarkup?: InlineKeyboard
}

const DEFAULT_PARSE_MODE: 'HTML' = 'HTML'

export interface NotifyManagerDirectResult {
  ok: boolean
  skipped?: boolean
  error?: string
}

/**
 * Пуш конкретному менеджеру в личку Telegram.
 *
 * Если у юзера нет telegramChatId или он неактивен — НЕ шлёт ничего и
 * возвращает skipped:true. В MAX мы не уходим (управленческий канал
 * полностью Telegram, см. 5.8c).
 */
export async function notifyManagerDirect(
  userId: string,
  text: string,
  opts?: NotifyOptions
): Promise<NotifyManagerDirectResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, telegramChatId: true, isActive: true },
  })

  if (!user) {
    console.log(`[telegram/notify] skipped: user not found id=${userId}`)
    return { ok: false, skipped: true, error: 'user_not_found' }
  }
  if (!user.isActive) {
    console.log(`[telegram/notify] skipped: user inactive id=${userId} (${user.name})`)
    return { ok: false, skipped: true, error: 'user_inactive' }
  }
  if (!user.telegramChatId) {
    console.log(`[telegram/notify] skipped: no telegram chatId for user ${userId} (${user.name})`)
    return { ok: false, skipped: true, error: 'no_telegram_chat_id' }
  }

  const result = await sendTelegramMessage(user.telegramChatId, text, {
    parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
    replyMarkup: opts?.replyMarkup,
  })
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return { ok: true }
}

export interface NotifyAllManagersResult {
  sentTo: number
  skippedNoTelegram: number
  failed: number
}

/**
 * Пуш всем активным ADMIN/MANAGER c привязанным Telegram.
 *
 * skippedNoTelegram = active ADMIN+MANAGER без telegramChatId (нужно онбординг).
 * failed = ошибка от Telegram API при отправке (forbidden/chat_not_found/etc).
 *
 * Не кидает. Параллельная отправка через Promise.allSettled.
 */
export async function notifyAllManagersDirect(
  text: string,
  opts?: NotifyOptions
): Promise<NotifyAllManagersResult> {
  const allManagers = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { id: true, telegramChatId: true },
  })

  const withTelegram = allManagers.filter((m) => m.telegramChatId !== null)
  const skippedNoTelegram = allManagers.length - withTelegram.length

  if (withTelegram.length === 0) {
    console.warn(
      `[telegram/notify] notifyAllManagers: no managers with telegramChatId ` +
        `(total active managers: ${allManagers.length})`
    )
    return { sentTo: 0, skippedNoTelegram, failed: 0 }
  }

  const sends = await Promise.allSettled(
    withTelegram.map((m) =>
      sendTelegramMessage(m.telegramChatId as string, text, {
        parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
        replyMarkup: opts?.replyMarkup,
      })
    )
  )

  let sentTo = 0
  let failed = 0
  for (const s of sends) {
    if (s.status === 'fulfilled' && s.value.ok) sentTo++
    else failed++
  }

  console.log(
    `[telegram/notify] notifyAllManagers: sentTo=${sentTo} skippedNoTelegram=${skippedNoTelegram} failed=${failed}`
  )

  return { sentTo, skippedNoTelegram, failed }
}

export interface NotifyGroupResult {
  ok: boolean
  error?: string
}

/**
 * Сообщение в групповой чат менеджеров.
 *
 * Бот должен быть админом группы (или хотя бы участником с правом писать).
 * Если 403 (бот кикнут / не админ) — sendTelegramMessage поймает и вернёт error.
 */
export async function notifyGroup(text: string, opts?: NotifyOptions): Promise<NotifyGroupResult> {
  const { groupChatId } = getTelegramEnv()
  const result = await sendTelegramMessage(groupChatId, text, {
    parseMode: opts?.parseMode ?? DEFAULT_PARSE_MODE,
    replyMarkup: opts?.replyMarkup,
  })
  if (!result.ok) {
    console.error(`[telegram/notify] notifyGroup failed: ${result.error}`)
    return { ok: false, error: result.error }
  }
  return { ok: true }
}

/**
 * HTML escape для интерполяции пользовательских строк (имена клиентов,
 * локаций) в сообщения с parseMode='HTML'. Без этого Telegram упадёт
 * на `<`, `>`, `&` в данных.
 *
 * Кавычки в plain-тексте экранировать не нужно — они уходят как есть.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
