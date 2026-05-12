import { format as fnsFormat } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  getDailyQuestionText,
  getReminder14Text,
  getReminder1530Text,
  CUTOFF_NOTICE_TEXT,
  formatAcceptedReply,
  formatUpdatedReply,
  POST_CUTOFF_REPLY,
} from '@/lib/bot/templates'

const start = new Date(Date.UTC(2026, 4, 18, 0, 0, 0, 0)) // пн 18 мая 2026

function fmt(d: Date) {
  return `${fnsFormat(d, 'dd.MM', { locale: ru })} ${fnsFormat(d, 'EEEE', { locale: ru })}`
}

console.log('========== DAILY QUESTION (11:00 МСК) — 7 дней × 2 сценария ==========\n')
for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
  const sendDay = new Date(start)
  sendDay.setUTCDate(sendDay.getUTCDate() + dayOffset)

  const targetA = new Date(sendDay)
  targetA.setUTCDate(targetA.getUTCDate() + 1)

  const targetB = new Date(sendDay)
  targetB.setUTCDate(targetB.getUTCDate() + 3)

  console.log(`--- SEND: ${fmt(sendDay)} | TARGET: ${fmt(targetA)} ---`)
  console.log(getDailyQuestionText(targetA, sendDay))
  console.log()
  console.log(`--- SEND: ${fmt(sendDay)} | TARGET: ${fmt(targetB)} ---`)
  console.log(getDailyQuestionText(targetB, sendDay))
  console.log()
}

console.log('========== REMINDER 14:00 МСК — все 7 формулировок ==========\n')
for (let i = 0; i < 7; i++) {
  const d = new Date(start)
  d.setUTCDate(d.getUTCDate() + i)
  console.log(`variant=${d.getDate() % 7} (target=${fmt(d)})`)
  console.log(getReminder14Text(d))
  console.log()
}

console.log('========== REMINDER 15:30 МСК — все 7 формулировок ==========\n')
for (let i = 0; i < 7; i++) {
  const d = new Date(start)
  d.setUTCDate(d.getUTCDate() + i)
  console.log(`variant=${d.getDate() % 7} (target=${fmt(d)})`)
  console.log(getReminder1530Text(d))
  console.log()
}

console.log('========== CUTOFF NOTICE 16:00 МСК ==========\n')
console.log(CUTOFF_NOTICE_TEXT)
console.log()

console.log('========== ОТВЕТЫ БОТА ПОСЛЕ ПАРСИНГА ==========\n')
console.log('--- formatAcceptedReply, одна точка ---')
console.log(formatAcceptedReply([{ locationName: 'Офис', portions: 50 }]))
console.log()
console.log('--- formatAcceptedReply, две точки ---')
console.log(
  formatAcceptedReply([
    { locationName: 'Офис', portions: 30 },
    { locationName: 'Стройка', portions: 50 },
  ])
)
console.log()
console.log('--- formatUpdatedReply, одна точка ---')
console.log(formatUpdatedReply([{ locationName: 'Офис', portions: 60 }]))
console.log()
console.log('--- formatUpdatedReply, две точки ---')
console.log(
  formatUpdatedReply([
    { locationName: 'Офис', portions: 40 },
    { locationName: 'Стройка', portions: 70 },
  ])
)
console.log()
console.log('--- POST_CUTOFF_REPLY ---')
console.log(POST_CUTOFF_REPLY)
