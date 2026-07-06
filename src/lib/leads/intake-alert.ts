import { sendTelegramMessage } from '@/lib/telegram/send'
import { readDirectChatId } from '@/lib/telegram/env'

/**
 * Алёрты о сбоях приёмника заявок (/api/leads/intake) в чат «Директ от Бориса»
 * (TELEGRAM_DIRECT_CHAT_ID) — тем же ботом/каналом, что и алёрты Бориса-Директа,
 * с пометкой [INTAKE]. Отдельный лёгкий помощник (без командной обвязки
 * boris-direct/telegram.ts), чтобы клиентский hot-path не тянул её импортом.
 *
 * ЖЕЛЕЗНО: НИКОГДА не кидает и не меняет ответ клиенту — потеря заявки должна
 * стать ШУМНОЙ, но сам алёрт — best effort (сбой Telegram не ломает intake).
 * Текст уже собран и экранирован вызывающим (parseMode HTML).
 */
export async function notifyIntakeAlert(text: string): Promise<void> {
  try {
    let chatId: string
    try {
      chatId = readDirectChatId()
    } catch {
      // ENV чата Директа не задан — алёрт отправить некуда, но intake не роняем.
      console.warn('[leads/intake] TELEGRAM_DIRECT_CHAT_ID не задан — алёрт не отправлен')
      return
    }
    const result = await sendTelegramMessage(chatId, `🅰️ [INTAKE] ${text}`, { parseMode: 'HTML' })
    if (!result.ok) {
      console.error(`[leads/intake] алёрт в чат Директа не ушёл: ${result.error}`)
    }
  } catch (err) {
    // Двойная страховка: даже неожиданный throw не должен всплыть в роут.
    console.error('[leads/intake] notifyIntakeAlert threw:', err instanceof Error ? err.message : err)
  }
}
