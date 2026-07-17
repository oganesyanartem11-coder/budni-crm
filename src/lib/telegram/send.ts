import { GrammyError, type InlineKeyboard } from 'grammy'
import { getTelegramBot } from './bot'

/** Жёсткий лимит длины одного сообщения Telegram Bot API. */
export const TELEGRAM_MAX_LEN = 4096

/**
 * Разбить длинный текст на части ≤ maxLen для отправки в Telegram. В ОТЛИЧИЕ от обрезки
 * «…» — смысл не теряем: режем по границам СТРОК (\n), пакуя жадно. Склейка частей тем же
 * \n даёт исходный текст байт-в-байт. Единственная строка длиннее лимита (патология) —
 * режется жёстко по символам, но без потери контента. text ≤ maxLen → [text] как есть.
 */
export function splitForTelegram(text: string, maxLen: number = TELEGRAM_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text]
  const parts: string[] = []
  let cur = ''
  const flush = (): void => {
    if (cur !== '') {
      parts.push(cur)
      cur = ''
    }
  }
  for (const rawLine of text.split('\n')) {
    const pieces = rawLine.length <= maxLen ? [rawLine] : hardSlice(rawLine, maxLen)
    for (const piece of pieces) {
      const candidate = cur === '' ? piece : `${cur}\n${piece}`
      if (candidate.length <= maxLen) {
        cur = candidate
      } else {
        flush()
        cur = piece // piece гарантированно ≤ maxLen (hardSlice)
      }
    }
  }
  flush()
  return parts
}

/** Нарезать одну сверхдлинную строку на куски ≤ maxLen (последнее средство). */
function hardSlice(s: string, maxLen: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen))
  return out
}

export interface SendTelegramMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2'
  replyMarkup?: InlineKeyboard
}

export type SendTelegramMessageResult =
  | { ok: true }
  | { ok: false; error: 'forbidden' | 'chat_not_found' | string }

/**
 * Отправка сообщения через Telegram Bot API.
 *
 * Никогда не кидает — все ошибки возвращает в результате, чтобы один
 * заблокированный получатель не ронял всю рассылку.
 *
 * - 403 (Forbidden: bot was blocked / user is deactivated / chat not started) → { ok: false, error: 'forbidden' }
 * - 400 (Bad Request: chat not found) → { ok: false, error: 'chat_not_found' }
 * - всё остальное → { ok: false, error: <error.message> }
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options?: SendTelegramMessageOptions
): Promise<SendTelegramMessageResult> {
  try {
    const bot = await getTelegramBot()
    const apiOptions: { parse_mode?: 'HTML' | 'MarkdownV2'; reply_markup?: InlineKeyboard } = {}
    if (options?.parseMode) apiOptions.parse_mode = options.parseMode
    if (options?.replyMarkup) apiOptions.reply_markup = options.replyMarkup
    await bot.api.sendMessage(chatId, text, apiOptions)
    return { ok: true }
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        console.warn(`[telegram] sendMessage forbidden chat=${chatId}: ${err.description}`)
        return { ok: false, error: 'forbidden' }
      }
      if (
        err.error_code === 400 &&
        /chat not found/i.test(err.description)
      ) {
        console.warn(`[telegram] sendMessage chat_not_found chat=${chatId}: ${err.description}`)
        return { ok: false, error: 'chat_not_found' }
      }
      console.error(
        `[telegram] sendMessage failed chat=${chatId} code=${err.error_code}: ${err.description}`
      )
      return { ok: false, error: err.description }
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[telegram] sendMessage unknown error chat=${chatId}:`, err)
    return { ok: false, error: message }
  }
}
