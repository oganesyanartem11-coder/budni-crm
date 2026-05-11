import { getMaxBot } from './client'

/**
 * Отправляет текст в персональный чат MAX (от лица бота).
 * Использует bot.api.sendMessageToChat — см. dist/api.d.ts SDK.
 */
export async function sendBotMessage(maxChatId: string, text: string): Promise<void> {
  const chatIdNum = Number(maxChatId)
  if (Number.isNaN(chatIdNum)) {
    throw new Error(`invalid maxChatId: ${maxChatId}`)
  }
  const bot = getMaxBot()
  await bot.api.sendMessageToChat(chatIdNum, text)
}
