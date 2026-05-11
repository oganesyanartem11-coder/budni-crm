import { randomBytes } from 'crypto'

/**
 * Имя бота в MAX. Используется для построения deep-link'ов.
 * Если бот поменяется — обнови здесь.
 */
export const MAX_BOT_USERNAME = 'id503018232259_bot'

/**
 * Генерирует случайный токен онбординга (32 hex-символа = 16 байт).
 * Достаточно уникально и читаемо в URL.
 */
export function generateOnboardingToken(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Строит deep-link, который при клике откроет бота в MAX
 * и пришлёт ему `bot_started` событие с payload=token.
 */
export function buildOnboardingDeeplink(token: string): string {
  return `https://max.ru/${MAX_BOT_USERNAME}?start=${token}`
}
