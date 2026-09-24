import { formatPhoneLink, isValidPhone } from '@/lib/utils/format'

/**
 * Телефон в канонические цифры '7XXXXXXXXXX' — тот же вид, что сайт budni.pro
 * шлёт в phone_digits (дедуп и поиск по LandingLead.phoneDigits). Принимает
 * маску «+7 (999) 123-45-67», «8 999 …», 10 цифр без кода. Нормализацию делает
 * formatPhoneLink (10 цифр → +7…, 8… → +7…), валидность — isValidPhone.
 * Не российский мобильный/городской формат или мусор → null.
 */
export function toPhoneDigits(raw: string | null | undefined): string | null {
  const link = formatPhoneLink(raw)
  if (!link) return null
  const digits = link.slice(1)
  return isValidPhone(digits) ? digits : null
}
