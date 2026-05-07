import { startOfWeek, endOfWeek, addWeeks, format, isSameWeek } from 'date-fns'
import { ru } from 'date-fns/locale'

/**
 * Возвращает понедельник недели для заданной даты (ISO неделя).
 * Время сбрасывается на 00:00:00.000.
 */
export function getMondayOfWeek(date: Date): Date {
  const monday = startOfWeek(date, { weekStartsOn: 1 })
  monday.setHours(0, 0, 0, 0)
  return monday
}

/**
 * Возвращает воскресенье недели для заданной даты.
 * Время устанавливается на 23:59:59.999.
 */
export function getSundayOfWeek(date: Date): Date {
  const sunday = endOfWeek(date, { weekStartsOn: 1 })
  sunday.setHours(23, 59, 59, 999)
  return sunday
}

/**
 * Сдвигает неделю на N недель (положительное вперёд, отрицательное назад).
 */
export function shiftWeek(date: Date, weeks: number): Date {
  return getMondayOfWeek(addWeeks(date, weeks))
}

/**
 * Форматирует диапазон недели для UI: "5–11 мая 2026".
 */
export function formatWeekRange(monday: Date): string {
  const sunday = getSundayOfWeek(monday)
  const sameMonth = monday.getMonth() === sunday.getMonth()
  if (sameMonth) {
    return `${format(monday, 'd', { locale: ru })}–${format(sunday, 'd MMMM yyyy', { locale: ru })}`
  }
  return `${format(monday, 'd MMM', { locale: ru })} – ${format(sunday, 'd MMM yyyy', { locale: ru })}`
}

/**
 * Возвращает true если заданная дата — текущая неделя.
 */
export function isCurrentWeek(date: Date): boolean {
  return isSameWeek(date, new Date(), { weekStartsOn: 1 })
}

/**
 * Названия дней недели (понедельник = 1).
 */
export const WEEKDAY_NAMES_FULL: Record<number, string> = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
}

export const WEEKDAY_NAMES_SHORT: Record<number, string> = {
  1: 'Пн',
  2: 'Вт',
  3: 'Ср',
  4: 'Чт',
  5: 'Пт',
  6: 'Сб',
  7: 'Вс',
}

/**
 * Возвращает дату для конкретного дня недели (1-7) от понедельника.
 */
export function getDateForDayOfWeek(monday: Date, dayOfWeek: number): Date {
  const date = new Date(monday)
  date.setDate(monday.getDate() + (dayOfWeek - 1))
  return date
}

/**
 * Финансовая неделя: Пт 00:00 → Чт 23:59 (по ТЗ).
 */
export function getFinancialWeek(date: Date): { from: Date; to: Date } {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)

  const dow = d.getDay()
  const backToFri = (dow - 5 + 7) % 7
  const from = new Date(d)
  from.setDate(d.getDate() - backToFri)
  from.setHours(0, 0, 0, 0)

  const to = new Date(from)
  to.setDate(from.getDate() + 6)
  to.setHours(23, 59, 59, 999)

  return { from, to }
}

export function getPreviousFinancialWeek(date: Date): { from: Date; to: Date } {
  const current = getFinancialWeek(date)
  const from = new Date(current.from)
  from.setDate(from.getDate() - 7)
  const to = new Date(current.to)
  to.setDate(to.getDate() - 7)
  return { from, to }
}

export type ReportPreset =
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'custom'

export interface PeriodRange {
  from: Date
  to: Date
  label: string
}

export function getPresetRange(preset: ReportPreset, customFrom?: string, customTo?: string): PeriodRange {
  const now = new Date()
  now.setHours(0, 0, 0, 0)

  switch (preset) {
    case 'this_week': {
      const { from, to } = getFinancialWeek(now)
      return { from, to, label: 'Эта финансовая неделя' }
    }
    case 'last_week': {
      const { from, to } = getPreviousFinancialWeek(now)
      return { from, to, label: 'Прошлая финансовая неделя' }
    }
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
      const to = new Date(now)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Этот месяц' }
    }
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const to = new Date(now.getFullYear(), now.getMonth(), 0)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Прошлый месяц' }
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3)
      const from = new Date(now.getFullYear(), q * 3, 1)
      const to = new Date(now)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Этот квартал' }
    }
    case 'last_quarter': {
      const q = Math.floor(now.getMonth() / 3)
      const from = new Date(now.getFullYear(), (q - 1) * 3, 1)
      const to = new Date(now.getFullYear(), q * 3, 0)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Прошлый квартал' }
    }
    case 'this_year': {
      const from = new Date(now.getFullYear(), 0, 1)
      const to = new Date(now)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Этот год' }
    }
    case 'custom':
    default: {
      const from = customFrom ? new Date(customFrom) : now
      const to = customTo ? new Date(customTo) : now
      from.setHours(0, 0, 0, 0)
      to.setHours(23, 59, 59, 999)
      return { from, to, label: 'Произвольный период' }
    }
  }
}
