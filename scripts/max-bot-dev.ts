import { getMaxBot } from '../src/lib/max/client'
import { handleMessage, handleBotStarted } from '../src/lib/max/handlers'

async function main() {
  if (process.env.MAX_TRANSPORT !== 'long_polling') {
    console.error('MAX_TRANSPORT must be set to "long_polling" for the dev worker')
    console.error('Add MAX_TRANSPORT=long_polling to .env.local')
    process.exit(1)
  }

  const bot = getMaxBot()
  bot.on('message_created', handleMessage)
  bot.on('bot_started', handleBotStarted)

  console.log('[MAX] long polling worker started')
  await bot.start()
}

main().catch((e) => {
  console.error('[MAX] worker fatal:', e)
  process.exit(1)
})
