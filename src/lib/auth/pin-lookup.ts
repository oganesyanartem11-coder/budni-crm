import { createHmac } from 'crypto'

/**
 * Детерминированный HMAC-производный «short-key» по PIN'у для O(1) lookup
 * пользователя на логине вместо O(N) bcrypt-перебора.
 *
 * - HMAC-SHA256 (а не голый SHA) с секретом из JWT_SECRET: голый хэш 4-значного
 *   PIN перебирается за наносекунды (всего 10⁴ комбинаций). С keyed HMAC
 *   атакующему нужен ещё и JWT_SECRET — а если он есть, проблем больше, чем PIN'ы.
 * - 16 hex = 64 бита: коллизия по дню рождения на 10⁴ PIN'ов исключена,
 *   но индекс заметно компактнее полного 64-значного hex.
 * - Это lookup-индекс, НЕ замена bcrypt: после positive lookup всё равно
 *   bcrypt.compare к pinHash для константного времени и стойкости.
 */
export function hashPinLookup(pin: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  return createHmac('sha256', secret).update(pin).digest('hex').slice(0, 16)
}
