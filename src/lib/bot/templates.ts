import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { toZonedTime } from 'date-fns-tz'
import { formatDateLong } from '@/lib/utils/format'

export type ReplyTemplateKey =
  | 'ONBOARDING'
  | 'ACCEPTED'
  | 'UPDATED'
  | 'ESCALATED_TO_MANAGER'
  | 'POST_CUTOFF'

interface TemplateContext {
  items?: Array<{ locationName: string; portions: number }>
  deliveryDate?: Date
  oldPortions?: number
  newPortions?: number
}

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

export function getBotReplyTemplate(key: ReplyTemplateKey, ctx: TemplateContext = {}): string {
  switch (key) {
    case 'ONBOARDING':
      return 'Здравствуйте! Это бот компании «Будни». Через этот чат я буду каждый день уточнять количество порций на следующий день. Если возникнут вопросы — передам менеджеру.'
    case 'ACCEPTED': {
      const lines = (ctx.items ?? []).map((i) => `${i.locationName}: ${i.portions} порций`).join(', ')
      const dateStr = ctx.deliveryDate ? `на ${formatDateLong(ctx.deliveryDate)}` : 'на завтра'
      return `Принято: ${lines} ${dateStr}. Спасибо!`
    }
    case 'UPDATED':
      return `Обновлено: было ${ctx.oldPortions ?? '?'} порций, стало ${ctx.newPortions ?? '?'}.`
    case 'ESCALATED_TO_MANAGER':
      return 'Передаём вопрос менеджеру — скоро свяжется.'
    case 'POST_CUTOFF':
      return 'Приём заказов на завтра уже закрыт. По любым изменениям свяжитесь с менеджером.'
  }
}
