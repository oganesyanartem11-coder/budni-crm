import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
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

/**
 * Текст ежедневного вопроса от cron'а 13:00 МСК.
 *
 * Структура: шапка `Заявка на DD.MM, день_недели` + пустая строка + тело.
 * Тело — одна из 7 формулировок по `deliveryDate.getDate() % 7` (детерминированно,
 * все клиенты с одинаковым deliveryDate видят одинаковый текст).
 *
 * todayInMsk — reserved for future use, e.g. сегодня/завтра wording.
 */
export function getDailyQuestionText(deliveryDate: Date, todayInMsk: Date): string {
  void todayInMsk
  const dateNumeric = fnsFormat(deliveryDate, 'dd.MM', { locale: ru }) // "13.05"
  const weekdayFull = fnsFormat(deliveryDate, 'EEEE', { locale: ru }) // "среда"
  const header = `Заявка на ${dateNumeric}, ${weekdayFull}`

  const idx = deliveryDate.getDate() % 7
  const variants = [
    `Добрый день! Сколько порций? Ждём ответ до 16:00.`,
    `Здравствуйте! Подскажите, пожалуйста, количество порций.`,
    `Добрый день! Сколько порций готовить?`,
    `Здравствуйте! Уточните, пожалуйста, сколько порций.`,
    `Добрый день! Сколько порций нужно? Ответ ждём до 16:00.`,
    `Здравствуйте! Сообщите, пожалуйста, количество порций.`,
    `Добрый день! Поделитесь, пожалуйста, количеством порций.`,
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
