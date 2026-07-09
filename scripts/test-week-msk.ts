import {
  getMondayOfWeek,
  getSundayOfWeek,
  shiftWeek,
  isCurrentWeek,
  getDateForDayOfWeek,
  formatWeekRange,
} from '../src/lib/utils/week'

interface IsoCase {
  name: string
  actual: string
  expected: string
}

const isoCases: IsoCase[] = [
  {
    name: 'getMondayOfWeek: Friday 22 May 18:00 MSK (UTC 15:00) → Mon 18 May 00:00 MSK',
    actual: getMondayOfWeek(new Date('2026-05-22T15:00:00.000Z')).toISOString(),
    expected: '2026-05-17T21:00:00.000Z',
  },
  {
    name: 'getMondayOfWeek: Mon 18 May 03:00 MSK (UTC 00:00) → Mon 18 May 00:00 MSK',
    actual: getMondayOfWeek(new Date('2026-05-18T00:00:00.000Z')).toISOString(),
    expected: '2026-05-17T21:00:00.000Z',
  },
  {
    name: 'getMondayOfWeek: idempotent on already-Monday-midnight MSK',
    actual: getMondayOfWeek(new Date('2026-05-17T21:00:00.000Z')).toISOString(),
    expected: '2026-05-17T21:00:00.000Z',
  },
  {
    name: 'shiftWeek(+1): MSK Mon 18 May → MSK Mon 25 May',
    actual: shiftWeek(new Date('2026-05-17T21:00:00.000Z'), 1).toISOString(),
    expected: '2026-05-24T21:00:00.000Z',
  },
  {
    name: 'shiftWeek(-1): MSK Mon 18 May → MSK Mon 11 May',
    actual: shiftWeek(new Date('2026-05-17T21:00:00.000Z'), -1).toISOString(),
    expected: '2026-05-10T21:00:00.000Z',
  },
  {
    name: 'getSundayOfWeek: MSK Mon 18 May → MSK Sun 24 May 23:59:59.999',
    actual: getSundayOfWeek(new Date('2026-05-17T21:00:00.000Z')).toISOString(),
    expected: '2026-05-24T20:59:59.999Z',
  },
  {
    name: 'getMondayOfWeek: Sun 28 Dec 2025 15:00 MSK → Mon 22 Dec 2025 00:00 MSK',
    actual: getMondayOfWeek(new Date('2025-12-28T12:00:00.000Z')).toISOString(),
    expected: '2025-12-21T21:00:00.000Z',
  },
  {
    name: 'getSundayOfWeek: MSK Mon 29 Dec 2025 → MSK Sun 4 Jan 2026 23:59:59.999 (year boundary)',
    actual: getSundayOfWeek(new Date('2025-12-28T21:00:00.000Z')).toISOString(),
    expected: '2026-01-04T20:59:59.999Z',
  },
  {
    name: 'getDateForDayOfWeek(monday, 7): MSK Mon 18 May → MSK Sun 24 May 00:00',
    actual: getDateForDayOfWeek(new Date('2026-05-17T21:00:00.000Z'), 7).toISOString(),
    expected: '2026-05-23T21:00:00.000Z',
  },
  {
    name: 'getDateForDayOfWeek(monday, 1): MSK Mon 18 May → MSK Mon 18 May 00:00 (identity)',
    actual: getDateForDayOfWeek(new Date('2026-05-17T21:00:00.000Z'), 1).toISOString(),
    expected: '2026-05-17T21:00:00.000Z',
  },
]

let passed = 0
let failed = 0

for (const c of isoCases) {
  const ok = c.actual === c.expected
  console.log(`[${ok ? '✅ PASS' : '❌ FAIL'}] ${c.name}`)
  if (!ok) {
    console.log(`  actual:   ${c.actual}`)
    console.log(`  expected: ${c.expected}`)
  }
  if (ok) passed++
  else failed++
}

// isCurrentWeek — стабильно через нормализованные понедельники.
{
  const nowMonday = getMondayOfWeek(new Date())
  const nextMonday = shiftWeek(nowMonday, 1)
  const prevMonday = shiftWeek(nowMonday, -1)
  const tests: Array<{ name: string; actual: boolean; expected: boolean }> = [
    { name: 'isCurrentWeek(thisWeekMonday) === true', actual: isCurrentWeek(nowMonday), expected: true },
    { name: 'isCurrentWeek(nextWeekMonday) === false', actual: isCurrentWeek(nextMonday), expected: false },
    { name: 'isCurrentWeek(prevWeekMonday) === false', actual: isCurrentWeek(prevMonday), expected: false },
  ]
  for (const t of tests) {
    const ok = t.actual === t.expected
    console.log(`[${ok ? '✅ PASS' : '❌ FAIL'}] ${t.name}`)
    if (!ok) {
      console.log(`  actual:   ${t.actual}`)
      console.log(`  expected: ${t.expected}`)
    }
    if (ok) passed++
    else failed++
  }
}

// formatWeekRange — визуальная проверка MSK-вывода.
{
  const visualCases = [
    {
      name: 'formatWeekRange: same month (Пн 18 — Вс 24 мая)',
      monday: '2026-05-17T21:00:00.000Z',
      mustContain: ['18', '24', 'мая', '2026'],
    },
    {
      name: 'formatWeekRange: cross-month (Пн 27 апр — Вс 3 мая)',
      monday: '2026-04-26T21:00:00.000Z',
      mustContain: ['27', '3', 'апр', 'мая', '2026'],
    },
    {
      name: 'formatWeekRange: cross-year (Пн 29 дек 2025 — Вс 4 янв 2026)',
      monday: '2025-12-28T21:00:00.000Z',
      mustContain: ['29', '4', 'дек', 'янв', '2026'],
    },
  ]
  for (const c of visualCases) {
    const result = formatWeekRange(new Date(c.monday))
    const ok = c.mustContain.every((s) => result.includes(s))
    console.log(`[${ok ? '✅ PASS' : '❌ FAIL'}] ${c.name}`)
    console.log(`  result:   "${result}"`)
    if (!ok) {
      console.log(`  must contain: ${JSON.stringify(c.mustContain)}`)
    }
    if (ok) passed++
    else failed++
  }
}

console.log(`\nTotal: ${passed} passed, ${failed} failed (TZ=${process.env.TZ ?? '(default)'})`)
if (failed === 0) console.log('all tests passed')
process.exit(failed > 0 ? 1 : 0)
