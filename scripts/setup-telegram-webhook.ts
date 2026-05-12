/**
 * Разовая регистрация webhook'а у Telegram.
 *
 *   WEBHOOK_BASE_URL=https://budni-crm.vercel.app npm run telegram:setup-webhook
 *
 * Требуется в окружении (npm-скрипт сам подгружает .env.local через dotenv-cli):
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_WEBHOOK_SECRET
 *   - WEBHOOK_BASE_URL — https://... (обязателен https для Telegram)
 *
 * После выполнения Telegram будет слать апдейты на
 *   <WEBHOOK_BASE_URL>/api/telegram/webhook
 * с заголовком X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET.
 */
import { Bot, GrammyError } from 'grammy'

async function main(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  const baseUrl = process.env.WEBHOOK_BASE_URL

  if (!botToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN не задан (см. .env.local)')
    process.exit(1)
  }
  if (!webhookSecret) {
    console.error('❌ TELEGRAM_WEBHOOK_SECRET не задан (см. .env.local)')
    process.exit(1)
  }
  if (!baseUrl) {
    console.error(
      '❌ WEBHOOK_BASE_URL не задан. Пример:\n' +
        '   WEBHOOK_BASE_URL=https://budni-crm.vercel.app npm run telegram:setup-webhook'
    )
    process.exit(1)
  }
  if (!baseUrl.startsWith('https://')) {
    console.error(`❌ WEBHOOK_BASE_URL должен начинаться с https:// (получено: ${baseUrl})`)
    process.exit(1)
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`

  const bot = new Bot(botToken)

  console.log(`→ Регистрирую webhook: ${webhookUrl}`)
  try {
    await bot.api.setWebhook(webhookUrl, {
      secret_token: webhookSecret,
      drop_pending_updates: true,
    })
  } catch (err) {
    if (err instanceof GrammyError) {
      console.error(`❌ setWebhook упал: ${err.error_code} ${err.description}`)
    } else {
      console.error('❌ setWebhook упал:', err)
    }
    process.exit(1)
  }

  const info = await bot.api.getWebhookInfo()
  console.log('→ getWebhookInfo:')
  console.log(JSON.stringify(info, null, 2))

  if (info.url !== webhookUrl) {
    console.error(
      `⚠️  Telegram сообщает url=${info.url || '(пусто)'}, ожидалось ${webhookUrl}. ` +
        'Проверь корректность WEBHOOK_BASE_URL.'
    )
    process.exit(1)
  }

  console.log(`✅ Webhook зарегистрирован: ${webhookUrl}`)
}

main().catch((err) => {
  console.error('❌ Unexpected:', err)
  process.exit(1)
})
