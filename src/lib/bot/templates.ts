import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toZonedTime } from 'date-fns-tz'

export type ReplyTemplateKey = 'ONBOARDING'

const MSK_TIMEZONE = 'Europe/Moscow'

/**
 * Текст ежедневного вопроса от cron'а 13:00 МСК.
 *
 * Структура: шапка + пустая строка + тело.
 * Шапка по умолчанию — одна строка `Заявка на DD.MM, день_недели`.
 * Если СЕГОДНЯ в МСК понедельник или четверг — добавляется вторая строка
 * `Ожидаем заявку до 18:00` (напоминание о cut-off в начале и середине недели).
 *
 * Тело — одна из 7 формулировок по `deliveryDate.getDate() % 7`. Детерминированно:
 * все клиенты с одинаковым deliveryDate видят одинаковый текст.
 */
export function getDailyQuestionText(deliveryDate: Date, todayInMsk: Date): string {
  const dateNumeric = fnsFormat(deliveryDate, 'dd.MM', { locale: ru }) // "13.05"
  const weekdayFull = fnsFormat(deliveryDate, 'EEEE', { locale: ru }) // "среда"
  const line1 = `Заявка на ${dateNumeric}, ${weekdayFull}`

  // День недели «сегодня» в МСК. dow: 0=вс, 1=пн ... 6=сб.
  const mskToday = toZonedTime(todayInMsk, MSK_TIMEZONE)
  const dow = mskToday.getDay()
  const isReminderDay = dow === 1 || dow === 4
  const header = isReminderDay ? `${line1}\nОжидаем заявку до 18:00` : line1

  const idx = deliveryDate.getDate() % 7
  const variants = [
    `Добрый день! Сколько порций?`,
    `Здравствуйте! Сколько порций нужно?`,
    `Приветствую! Подскажите количество порций.`,
    `Добрый день! Сколько порций готовим?`,
    `Здравствуйте! Уточните количество порций, пожалуйста.`,
    `Приветствую! Напишите, пожалуйста, сколько порций.`,
    `Добрый день! Сколько порций понадобится?`,
  ]
  return `${header}\n\n${variants[idx]}`
}

// ─────────────────────────────────────────────────────────────────────
// 5.7b: ответы бота после парсинга
// ─────────────────────────────────────────────────────────────────────

export interface SavedItemForReply {
  locationName: string
  portions: number
}

/** Формат «Locationname — N» через запятую, мульти-локейшн. */
function formatItemsList(items: SavedItemForReply[]): string {
  return items.map((i) => `${i.locationName} — ${i.portions}`).join(', ')
}

/** Кейс A: первый ответ числом, до 18:00. */
export function formatAcceptedReply(items: SavedItemForReply[], deliveryDate: Date): string {
  const dateStr = fnsFormat(deliveryDate, 'dd.MM', { locale: ru })
  return `Принято на ${dateStr}: ${formatItemsList(items)}.`
}

/** Кейс B: повторный ответ числом (conv уже CONFIRMED), до 18:00. */
export function formatUpdatedReply(items: SavedItemForReply[], deliveryDate: Date): string {
  const dateStr = fnsFormat(deliveryDate, 'dd.MM', { locale: ru })
  return `Принято изменение, теперь на ${dateStr}: ${formatItemsList(items)}.`
}

/** Кейс C: ответ числом после 18:00 МСК. Один текст для первого и повторного. */
export const POST_CUTOFF_REPLY = 'Заявки принимаем до 18:00, уточняем по возможности.'

// ─────────────────────────────────────────────────────────────────────
// Legacy: используется только при онбординге через handlers.ts
// ─────────────────────────────────────────────────────────────────────

export function getBotReplyTemplate(key: ReplyTemplateKey): string {
  switch (key) {
    case 'ONBOARDING':
      return 'Здравствуйте! Это бот компании «Будни». Через этот чат я буду каждый день уточнять количество порций на следующий день. Если возникнут вопросы — передам менеджеру.'
  }
}
