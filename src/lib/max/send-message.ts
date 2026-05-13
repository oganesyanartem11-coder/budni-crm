import { getMaxBot } from './client'

/** Случайная задержка 15-30 сек для естественности ответа клиенту. */
function randomClientDelayMs(): number {
  return 15000 + Math.floor(Math.random() * 15000)
}

export interface SendBotMessageOptions {
  /**
   * По умолчанию true: перед отправкой ждём 15-30 сек, чтобы клиент в MAX
   * не видел мгновенный ответ бота. Cron-маршруты (daily-questions,
   * cutoff-notice, reminder-and-summary-1/2) передают false — там получателей
   * много, общая длительность превысила бы лимит Vercel-функции, а для
   * scheduled-рассылок ощущение «живой переписки» не нужно.
   */
  delay?: boolean
}

/**
 * Отправляет текст в персональный чат MAX (от лица бота).
 * Использует bot.api.sendMessageToChat — см. dist/api.d.ts SDK.
 */
export async function sendBotMessage(
  maxChatId: string,
  text: string,
  options: SendBotMessageOptions = {}
): Promise<void> {
  const chatIdNum = Number(maxChatId)
  if (Number.isNaN(chatIdNum)) {
    throw new Error(`invalid maxChatId: ${maxChatId}`)
  }
  const { delay = true } = options
  if (delay) {
    await new Promise((resolve) => setTimeout(resolve, randomClientDelayMs()))
  }
  const bot = getMaxBot()
  await bot.api.sendMessageToChat(chatIdNum, text)
}
