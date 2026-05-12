import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { getDailyQuestionText } from '@/lib/bot/templates'

// Старт — вторник 12 мая 2026 (UTC-полночь), 10 дней подряд.
const start = new Date(Date.UTC(2026, 4, 12, 0, 0, 0, 0))

for (let i = 0; i < 10; i++) {
  const target = new Date(start)
  target.setUTCDate(target.getUTCDate() + i)
  const variant = target.getUTCDate() % 7
  const headerDate = fnsFormat(target, 'dd.MM', { locale: ru })
  const weekday = fnsFormat(target, 'EEEE', { locale: ru })
  console.log(`=== target: ${headerDate}, ${weekday} (variant=${variant}) ===`)
  console.log(getDailyQuestionText(target, start))
  console.log('---')
}
