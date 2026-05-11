import { formatDateLong } from '@/lib/utils/format'

export type ReplyTemplateKey =
  | 'ONBOARDING'
  | 'DAILY_QUESTION'
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

const DAILY_QUESTION_VARIATIONS = [
  'Добрый день! Уточните, пожалуйста, сколько порций обеда привозить завтра?',
  'Подскажите по завтрашнему заказу — сколько порций обеда?',
  'Завтра обедаем — сколько порций нужно?',
]

export function getBotReplyTemplate(key: ReplyTemplateKey, ctx: TemplateContext = {}): string {
  switch (key) {
    case 'ONBOARDING':
      return 'Здравствуйте! Это бот компании «Будни». Через этот чат я буду каждый день уточнять количество порций на следующий день. Если возникнут вопросы — передам менеджеру.'
    case 'DAILY_QUESTION':
      return DAILY_QUESTION_VARIATIONS[Math.floor(Math.random() * DAILY_QUESTION_VARIATIONS.length)]
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
