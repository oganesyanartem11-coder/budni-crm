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

/**
 * "1 заказ", "2 заказа", "5 заказов"
 */
export function formatOrders(n: number): string {
  return `${n} ${pluralize(n, ['заказ', 'заказа', 'заказов'])}`
}

/**
 * "1 точка", "2 точки", "5 точек"
 */
export function formatLocations(n: number): string {
  return `${n} ${pluralize(n, ['точка', 'точки', 'точек'])}`
}

/**
 * "1 клиент", "2 клиента", "5 клиентов"
 */
export function formatClients(n: number): string {
  return `${n} ${pluralize(n, ['клиент', 'клиента', 'клиентов'])}`
}

/**
 * Маска телефона +7 (999) 999-99-99
 * На вход — любая строка (с цифрами и мусором).
 * На выход — отформатированная строка вида +7 (XXX) XXX-XX-XX.
 * Если цифр недостаточно — возвращает то что есть.
 */
export function formatPhoneMask(input: string): string {
  // Извлекаем только цифры
  let digits = input.replace(/\D/g, '')

  // Если ввели с 8 в начале (старый формат) — заменяем на 7
  if (digits.startsWith('8') && digits.length >= 11) {
    digits = '7' + digits.slice(1)
  }

  // Если первая цифра не 7 и есть хоть одна цифра — добавляем 7 в начало
  if (digits.length > 0 && !digits.startsWith('7')) {
    digits = '7' + digits
  }

  // Обрезаем до 11 цифр (7 + 10)
  digits = digits.slice(0, 11)

  // Форматируем
  if (digits.length === 0) return ''
  if (digits.length <= 1) return '+7'
  if (digits.length <= 4) return `+7 (${digits.slice(1)}`
  if (digits.length <= 7) return `+7 (${digits.slice(1, 4)}) ${digits.slice(4)}`
  if (digits.length <= 9) return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`
}

/**
 * Проверка что телефон в правильном формате (полностью заполненный +7 (XXX) XXX-XX-XX)
 */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('7')
}
