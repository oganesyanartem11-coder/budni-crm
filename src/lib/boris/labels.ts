/**
 * Русские человекочитаемые лейблы для AI-агента Бориса.
 *
 * Зачем: read-tools отдают модели сырые enum-значения (`LUNCH`, `CONFIRMED`)
 * и ISO-даты (`2026-05-28`). LLM их прямо пересказывает пользователю, и Боря
 * звучит как робот. Подменяем на момент возврата из tool.execute — модель
 * получит уже русскую сводку и будет говорить «обед» вместо «LUNCH».
 */

import type { MealType, OrderStatus } from '@prisma/client'

export const MEAL_TYPE_RU: Record<MealType, string> = {
  BREAKFAST: 'завтрак',
  LUNCH: 'обед',
  DINNER: 'ужин',
}

export const ORDER_STATUS_RU: Record<OrderStatus, string> = {
  DRAFT: 'черновик',
  PENDING_CONFIRMATION: 'ждёт подтверждения клиента',
  CONFIRMED: 'подтверждён',
  LOCKED: 'в производстве',
  IN_PRODUCTION: 'в производстве',
  OUT_FOR_DELIVERY: 'в доставке',
  DELIVERED: 'доставлен',
  CANCELLED: 'отменён',
}

const RU_WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
]
const RU_MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

/**
 * 'YYYY-MM-DD' или Date → 'четверг, 28 мая'.
 * Order.deliveryDate в БД хранится как @db.Date (без TZ) — для корректного
 * weekday/числа учитываем МСК (+3h к UTC).
 */
export function formatDateHuman(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const mskMs = date.getTime() + 3 * 60 * 60 * 1000
  const msk = new Date(mskMs)
  const weekday = RU_WEEKDAYS[msk.getUTCDay()]
  const day = msk.getUTCDate()
  const month = RU_MONTHS[msk.getUTCMonth()]
  return `${weekday}, ${day} ${month}`
}

/** «1 порция» / «2 порции» / «5 порций» — русское склонение. */
export function formatPortions(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} порция`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} порции`
  return `${n} порций`
}
