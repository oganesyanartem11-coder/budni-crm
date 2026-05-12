import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import { getDailyQuestionText } from '@/lib/bot/templates'

// Старт — понедельник 18 мая 2026, далее 7 дней.
const start = new Date(Date.UTC(2026, 4, 18, 0, 0, 0, 0))

function fmt(d: Date) {
  return `${fnsFormat(d, 'dd.MM', { locale: ru })} ${fnsFormat(d, 'EEEE', { locale: ru })}`
}

for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
  const sendDay = new Date(start)
  sendDay.setUTCDate(sendDay.getUTCDate() + dayOffset)

  const targetA = new Date(sendDay)
  targetA.setUTCDate(targetA.getUTCDate() + 1) // +1 день

  const targetB = new Date(sendDay)
  targetB.setUTCDate(targetB.getUTCDate() + 3) // +3 дня

  console.log(`=== SEND: ${fmt(sendDay)} | TARGET: ${fmt(targetA)} ===`)
  console.log(getDailyQuestionText(targetA, sendDay))
  console.log('---')
  console.log(`=== SEND: ${fmt(sendDay)} | TARGET: ${fmt(targetB)} ===`)
  console.log(getDailyQuestionText(targetB, sendDay))
  console.log('---')
}
