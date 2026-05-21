import {
  getFinancialWeek,
  getPreviousFinancialWeek,
  isInCurrentFinancialWeek,
} from '../src/lib/utils/week'

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const cases = [
  // Пт 2026-05-22 → неделя Сб 2026-05-16 ... Пт 2026-05-22
  { label: 'Friday',   input: new Date(2026, 4, 22), expectedFrom: '2026-05-16', expectedTo: '2026-05-22' },
  // Сб 2026-05-23 → неделя Сб 2026-05-23 ... Пт 2026-05-29
  { label: 'Saturday', input: new Date(2026, 4, 23), expectedFrom: '2026-05-23', expectedTo: '2026-05-29' },
  // Чт 2026-05-21 → неделя Сб 2026-05-16 ... Пт 2026-05-22
  { label: 'Thursday', input: new Date(2026, 4, 21), expectedFrom: '2026-05-16', expectedTo: '2026-05-22' },
]

let passed = 0
let failed = 0

for (const c of cases) {
  const { from, to } = getFinancialWeek(c.input)
  const ok = ymd(from) === c.expectedFrom && ymd(to) === c.expectedTo
  console.log(
    `[${c.label}] input=${ymd(c.input)}  got: ${ymd(from)} .. ${ymd(to)}  expected: ${c.expectedFrom} .. ${c.expectedTo}  ${ok ? '✅ PASS' : '❌ FAIL'}`
  )
  ok ? passed++ : failed++
}

// Дополнительная проверка: getPreviousFinancialWeek сдвигает на 7 дней
const prev = getPreviousFinancialWeek(new Date(2026, 4, 22))
const prevOk = ymd(prev.from) === '2026-05-09' && ymd(prev.to) === '2026-05-15'
console.log(
  `[Prev week ←Fri 22] got: ${ymd(prev.from)} .. ${ymd(prev.to)}  expected: 2026-05-09 .. 2026-05-15  ${prevOk ? '✅ PASS' : '❌ FAIL'}`
)
prevOk ? passed++ : failed++

// isInCurrentFinancialWeek: сегодняшняя дата должна быть в текущей неделе
const todayInWeek = isInCurrentFinancialWeek(new Date())
console.log(`[isInCurrentFinancialWeek(today)] = ${todayInWeek}  ${todayInWeek ? '✅ PASS' : '❌ FAIL'}`)
todayInWeek ? passed++ : failed++

console.log(`\nTotal: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
