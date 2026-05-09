import { Bot } from '@maxhub/max-bot-api'

export type MaxTransport = 'webhook' | 'long_polling'

let botInstance: Bot | null = null

/**
 * Singleton-инстанс Bot из @maxhub/max-bot-api.
 * Лениво инициализируется по первому вызову, чтобы не падать на импорте
 * в окружениях где MAX_BOT_TOKEN отсутствует (build-time, тесты).
 */
export function getMaxBot(): Bot {
  if (!process.env.MAX_BOT_TOKEN) {
    throw new Error('MAX_BOT_TOKEN is not set')
  }
  if (!botInstance) {
    botInstance = new Bot(process.env.MAX_BOT_TOKEN)
  }
  return botInstance
}

export function getTransport(): MaxTransport {
  const t = process.env.MAX_TRANSPORT
  return t === 'long_polling' ? 'long_polling' : 'webhook'
}
