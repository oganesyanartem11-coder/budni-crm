// Валидация ENV для Telegram-бота (Спринт 5.8a+).
// Все проверки ленивые — кидаются только при первом вызове getTelegramEnv(),
// чтобы билд и импорт не падали пока переменные не проставлены.

export interface TelegramEnv {
  botToken: string
  botUsername: string
  webhookSecret: string
  groupChatId: string
  appBaseUrl: string
}

const BOT_TOKEN_REGEX = /^[0-9]+:[A-Za-z0-9_-]+$/
const MIN_BOT_TOKEN_LENGTH = 40
const MIN_WEBHOOK_SECRET_LENGTH = 16
const MIN_GROUP_CHAT_ID_LENGTH = 6
const DEFAULT_APP_BASE_URL = 'https://budni-crm.vercel.app'

function fail(varName: string, reason: string): never {
  throw new Error(
    `[telegram/env] ${varName} is invalid: ${reason}. ` +
      `Проверь .env.local (локально) и Vercel Environment Variables (прод). ` +
      `См. docs/SPRINT_5.8_TELEGRAM_SETUP.md`
  )
}

function readBotToken(): string {
  const v = process.env.TELEGRAM_BOT_TOKEN
  if (!v) fail('TELEGRAM_BOT_TOKEN', 'not set')
  if (v.length < MIN_BOT_TOKEN_LENGTH) {
    fail('TELEGRAM_BOT_TOKEN', `too short (${v.length} < ${MIN_BOT_TOKEN_LENGTH})`)
  }
  if (!BOT_TOKEN_REGEX.test(v)) {
    fail('TELEGRAM_BOT_TOKEN', 'expected format <digits>:<alphanumeric/_-> (см. @BotFather)')
  }
  return v
}

function readBotUsername(): string {
  const v = process.env.TELEGRAM_BOT_USERNAME
  if (!v) fail('TELEGRAM_BOT_USERNAME', 'not set')
  if (v.startsWith('@')) {
    fail('TELEGRAM_BOT_USERNAME', 'не должен начинаться с @, передавай username без префикса')
  }
  return v
}

function readWebhookSecret(): string {
  const v = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!v) fail('TELEGRAM_WEBHOOK_SECRET', 'not set')
  if (v.length < MIN_WEBHOOK_SECRET_LENGTH) {
    fail(
      'TELEGRAM_WEBHOOK_SECRET',
      `too short (${v.length} < ${MIN_WEBHOOK_SECRET_LENGTH}). Сгенерируй: openssl rand -hex 32`
    )
  }
  return v
}

function readGroupChatId(): string {
  const v = process.env.TELEGRAM_GROUP_CHAT_ID
  if (!v) fail('TELEGRAM_GROUP_CHAT_ID', 'not set')
  if (!v.startsWith('-')) {
    fail(
      'TELEGRAM_GROUP_CHAT_ID',
      'групповой chat_id в Telegram всегда отрицательный (начинается с -). Проверь, что добавил бота в группу и взял chat_id оттуда'
    )
  }
  if (v.length < MIN_GROUP_CHAT_ID_LENGTH) {
    fail('TELEGRAM_GROUP_CHAT_ID', `too short (${v.length} < ${MIN_GROUP_CHAT_ID_LENGTH})`)
  }
  return v
}

function readAppBaseUrl(): string {
  const v = process.env.TELEGRAM_APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL
  if (!/^https:\/\//.test(v)) {
    fail('TELEGRAM_APP_BASE_URL', `должен начинаться с https:// (получено: ${v})`)
  }
  // Без trailing slash — кнопки сами добавляют /...
  return v.replace(/\/$/, '')
}

export function getTelegramEnv(): TelegramEnv {
  return {
    botToken: readBotToken(),
    botUsername: readBotUsername(),
    webhookSecret: readWebhookSecret(),
    groupChatId: readGroupChatId(),
    appBaseUrl: readAppBaseUrl(),
  }
}
