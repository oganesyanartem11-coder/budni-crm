import { GrammyError } from 'grammy'
import { getTelegramBot } from './bot'

export interface SendTelegramMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2'
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
    await bot.api.sendMessage(
      chatId,
      text,
      options?.parseMode ? { parse_mode: options.parseMode } : undefined
    )
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
