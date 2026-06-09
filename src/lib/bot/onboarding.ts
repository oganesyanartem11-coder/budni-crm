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

/**
 * 7.56: токен инвайта для привязки MAX-пользователя — 16 символов base64url
 * (12 случайных байт). Короче onboarding-токена, влезает в payload (лимит 128).
 */
export function generateInviteToken(): string {
  return randomBytes(12).toString('base64url')
}
