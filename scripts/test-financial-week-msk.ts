import { getFinancialWeek } from '../src/lib/utils/week'

// Утилита: дата представлена в MSK-календаре.
function fmtMsk(d: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d)
}

const cases: Array<{ name: string; input: string; expectFromMskDay: string; expectToMskDay: string }> = [
  {
    name: 'Friday 22 May 11:00 MSK (UTC 08:00)',
    input: '2026-05-22T08:00:00.000Z',
    expectFromMskDay: '16.05.2026',
    expectToMskDay: '22.05.2026',
  },
  {
    name: 'Saturday 23 May 01:00 MSK (UTC 22.05 22:00)',
    input: '2026-05-22T22:00:00.000Z',
    expectFromMskDay: '23.05.2026',
    expectToMskDay: '29.05.2026',
  },
  {
    name: 'Friday 22 May 23:30 MSK (UTC 20:30)',
    input: '2026-05-22T20:30:00.000Z',
    expectFromMskDay: '16.05.2026',
    expectToMskDay: '22.05.2026',
  },
  {
    name: 'Saturday 16 May 00:01 MSK (UTC 15.05 21:01)',
    input: '2026-05-15T21:01:00.000Z',
    expectFromMskDay: '16.05.2026',
    expectToMskDay: '22.05.2026',
  },
]

let passed = 0
let failed = 0

for (const c of cases) {
  const fw = getFinancialWeek(new Date(c.input))
  const fromMsk = fmtMsk(fw.from).slice(0, 10)
  const toMsk = fmtMsk(fw.to).slice(0, 10)
  const ok = fromMsk === c.expectFromMskDay && toMsk === c.expectToMskDay
  console.log(`[${ok ? '✅ PASS' : '❌ FAIL'}] ${c.name}`)
  console.log(`  input:    ${c.input}`)
  console.log(`  from MSK: ${fmtMsk(fw.from)} (expected day ${c.expectFromMskDay})`)
  console.log(`  to   MSK: ${fmtMsk(fw.to)}   (expected day ${c.expectToMskDay})`)
  console.log(`  from ISO: ${fw.from.toISOString()}`)
  console.log(`  to   ISO: ${fw.to.toISOString()}`)
  if (ok) passed++
  else failed++
}

console.log(`\nTotal: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
