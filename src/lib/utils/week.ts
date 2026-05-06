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
