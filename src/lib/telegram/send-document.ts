import { GrammyError, InputFile } from 'grammy'
import { getTelegramBot } from './bot'

export interface SendTelegramDocumentParams {
  chatId: string
  buffer: Buffer
  filename: string
  caption?: string
}

export interface SendTelegramDocumentResult {
  ok: boolean
  error?: string
}

/**
 * П2: отправка файла (PDF маршрутного листа) через Telegram Bot API.
 *
 * Никогда не кидает — все ошибки логирует и возвращает { ok:false, error }.
 * Зеркалит контракт sendTelegramMessage (send.ts), чтобы фолбэк-логика в
 * sendRouteSheetToProduction могла просто смотреть на result.ok.
 *
 * filename должен быть ASCII-safe (Telegram кладёт его в Content-Disposition).
 */
export async function sendTelegramDocument(
  params: SendTelegramDocumentParams
): Promise<SendTelegramDocumentResult> {
  const { chatId, buffer, filename, caption } = params
  try {
    const bot = await getTelegramBot()
    await bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
      caption,
      parse_mode: 'HTML',
    })
    return { ok: true }
  } catch (err) {
    if (err instanceof GrammyError) {
      if (err.error_code === 403) {
        console.warn(`[telegram] sendDocument forbidden chat=${chatId}: ${err.description}`)
        return { ok: false, error: 'forbidden' }
      }
      if (err.error_code === 400 && /chat not found/i.test(err.description)) {
        console.warn(`[telegram] sendDocument chat_not_found chat=${chatId}: ${err.description}`)
        return { ok: false, error: 'chat_not_found' }
      }
      console.error(
        `[telegram] sendDocument failed chat=${chatId} code=${err.error_code}: ${err.description}`
      )
      return { ok: false, error: err.description }
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[telegram] sendDocument unknown error chat=${chatId}:`, err)
    return { ok: false, error: message }
  }
}
