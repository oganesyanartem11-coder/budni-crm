import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'

/**
 * Форматирует деньги: 12450 → "12 450 ₽"
 */
export function formatMoney(amount: number | string, options?: { withKopecks?: boolean }): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (Number.isNaN(num)) return '—'

  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: options?.withKopecks ? 2 : 0,
    maximumFractionDigits: options?.withKopecks ? 2 : 0,
  }).format(num)

  return `${formatted} ₽`
}

/**
 * Форматирует дату для UI: "Чт, 7 мая"
 */
export function formatDateShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return fnsFormat(d, 'EEEEEE, d MMMM', { locale: ru })
}

/**
 * Форматирует дату для UI с годом: "Чт, 7 мая 2026"
 */
export function formatDateLong(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return fnsFormat(d, 'EEEEEE, d MMMM yyyy', { locale: ru })
}

/**
 * Форматирует дату для печати/таблиц: "07.05.2026"
 */
export function formatDateNumeric(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return fnsFormat(d, 'dd.MM.yyyy', { locale: ru })
}

/**
 * Форматирует время: "11:30"
 */
export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return fnsFormat(d, 'HH:mm', { locale: ru })
}

/**
 * Окно доставки: "11:30 — 12:00"
 */
export function formatDeliveryWindow(from?: string | null, to?: string | null): string {
  if (!from && !to) return '—'
  if (from && to) return `${from} — ${to}`
  return from ?? to ?? '—'
}

/**
 * Склонение существительных по числу
 * pluralize(5, ['порция', 'порции', 'порций']) → "порций"
 */
export function pluralize(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100
  const lastDigit = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (lastDigit > 1 && lastDigit < 5) return forms[1]
  if (lastDigit === 1) return forms[0]
  return forms[2]
}

/**
 * "5 порций", "1 порция", "23 порции"
 */
export function formatPortions(n: number): string {
  return `${n} ${pluralize(n, ['порция', 'порции', 'порций'])}`
}
