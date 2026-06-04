import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toZonedTime } from 'date-fns-tz'
import { formatPortions } from '@/lib/utils/format'
import { WELCOME_FIXED } from './welcome'

export type ReplyTemplateKey = 'ONBOARDING'

const MSK_TIMEZONE = 'Europe/Moscow'

/**
 * Текст ежедневного вопроса от cron'а 11:00 МСК.
 *
 * Структура: шапка + пустая строка + тело.
 * Шапка по умолчанию — одна строка `Заявка на DD.MM, день_недели`.
 * Если СЕГОДНЯ в МСК понедельник или четверг — добавляется вторая строка
 * `Ожидаем заявку до 16:00` (напоминание о cut-off в начале и середине недели).
 *
 * Тело — одна из 7 формулировок по `deliveryDate.getDate() % 7`. Детерминированно:
 * все клиенты с одинаковым deliveryDate видят одинаковый текст.
 */
export function getDailyQuestionText(deliveryDate: Date, todayInMsk: Date): string {
  const dateNumeric = fnsFormat(deliveryDate, 'dd.MM', { locale: ru })
  const weekdayFull = fnsFormat(deliveryDate, 'EEEE', { locale: ru })
  const line1 = `Заявка на ${dateNumeric}, ${weekdayFull}`

  const mskToday = toZonedTime(todayInMsk, MSK_TIMEZONE)
  const dow = mskToday.getDay()
  const isReminderDay = dow === 1 || dow === 4
  const header = isReminderDay ? `${line1}\nОжидаем заявку до 16:00` : line1

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

/** Напоминание-1 (14:00 МСК) — без шапки, чистый одиночный вопрос. */
export function getReminder14Text(deliveryDate: Date): string {
  const idx = deliveryDate.getDate() % 7
  const variants = [
    `Напомним о заявке — сколько порций готовим?`,
    `Подскажете количество порций?`,
    `Ждём заявку — сколько порций нужно?`,
    `Уточните, пожалуйста, сколько порций.`,
    `Сколько порций готовим на завтра?`,
    `Напоминаем о заявке — какое количество порций?`,
    `Подскажите, сколько порций понадобится?`,
  ]
  return variants[idx]
}

/** Напоминание-2 (15:30 МСК) — без шапки, акцент на cut-off в 16:00. */
export function getReminder1530Text(deliveryDate: Date): string {
  const idx = deliveryDate.getDate() % 7
  const variants = [
    `Ждём ваш ответ — заявки принимаем до 16:00.`,
    `До 16:00 ещё есть время — подскажите количество порций.`,
    `Не забудьте про заявку — принимаем до 16:00.`,
    `До закрытия приёма заявок остался час — ждём от вас количество.`,
    `Заявки принимаем до 16:00 — будем ждать.`,
    `Напоминаем, заявки принимаем до 16:00.`,
    `Уточните, пожалуйста, количество — приём до 16:00.`,
  ]
  return variants[idx]
}

/** Cutoff-notice (16:00 МСК) — приём закрыт. */
export const CUTOFF_NOTICE_TEXT = 'Приём заявок на сегодня закрыт. Менеджер с вами свяжется.'

// ─────────────────────────────────────────────────────────────────────
// 5.7b/c: ответы бота после парсинга
// ─────────────────────────────────────────────────────────────────────

export interface SavedItemForReply {
  locationName: string
  portions: number
}

function formatItemsList(items: SavedItemForReply[]): string {
  return items.map((i) => `${i.locationName} — ${i.portions}`).join(', ')
}

/** Кейс A: первый ответ числом, до 16:00. */
export function formatAcceptedReply(items: SavedItemForReply[]): string {
  if (items.length === 1) {
    return `Принято, ${formatPortions(items[0].portions)}. Спасибо!`
  }
  return `Принято: ${formatItemsList(items)}. Спасибо!`
}

/** Кейс B: повторный ответ числом (conv уже CONFIRMED), до 16:00. */
export function formatUpdatedReply(items: SavedItemForReply[]): string {
  if (items.length === 1) {
    return `Принято, обновили на ${formatPortions(items[0].portions)}.`
  }
  return `Принято, обновили: ${formatItemsList(items)}.`
}

/**
 * Кейс C: ответ числом после cut-off МСК. Один текст для первого и повторного.
 *
 * MEGA-3 (П9): cut-off больше не хардкод «16:00» — подставляем индивидуальный
 * для клиента (напр. 08:40 у same-day-локаций). Стиль — «менеджеры компании»,
 * мягкое перепозиционирование (НЕ сухое «принимаем до 16:00»).
 */
export function getPostCutoffReply(cutoffStr: string): string {
  return `Спасибо! После ${cutoffStr} уже сложнее, но напишем на кухню — посмотрим что можно сделать.`
}

// ─────────────────────────────────────────────────────────────────────
// Legacy: используется только при онбординге через handlers.ts
// ─────────────────────────────────────────────────────────────────────

export function getBotReplyTemplate(key: ReplyTemplateKey): string {
  switch (key) {
    case 'ONBOARDING':
      // Перепозиционирование: ветвящийся welcome живёт в welcome.ts и зовётся
      // напрямую из handleBotStarted. Этот legacy-ключ оставлен для backward
      // compat и отдаёт нейтральный FIXED-вариант как fallback.
      return WELCOME_FIXED
  }
}
