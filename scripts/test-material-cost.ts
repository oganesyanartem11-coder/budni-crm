import { prisma } from '../src/lib/db/prisma'
import { getMaterialCostForRange } from '../src/lib/digest/material-cost'
import { REVENUE_STATUSES } from '../src/lib/constants/order'
import { getIngredientsSummary } from '../src/lib/db/queries/production'
import { getFinancialWeek } from '../src/lib/utils/week'

async function main() {
  console.log('=== Test 1: вчера, REVENUE_STATUSES ===')
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)
  const r1 = await getMaterialCostForRange(yesterday, yesterday, [...REVENUE_STATUSES])
  console.log('getMaterialCostForRange:', r1)
  const r1sanity = await getIngredientsSummary(yesterday)
  console.log('getIngredientsSummary totalCost:', r1sanity.totalCost, 'hasMenu:', r1sanity.hasMenu)
  console.log('(числа могут не совпасть точно из-за разницы статусов)')

  console.log('\n=== Test 2: последние 7 дней, REVENUE_STATUSES ===')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const r2 = await getMaterialCostForRange(weekAgo, today, [...REVENUE_STATUSES])
  console.log('Range:', weekAgo.toISOString().slice(0, 10), '..', today.toISOString().slice(0, 10))
  console.log('Result:', r2)

  console.log('\n=== Test 3: диапазон без меню (1900 год) ===')
  const oldFrom = new Date('1900-01-01')
  const oldTo = new Date('1900-01-07')
  const r3 = await getMaterialCostForRange(oldFrom, oldTo, [...REVENUE_STATUSES])
  console.log('Result:', r3)
  console.log('Ожидание: totalCost=0, daysWithoutMenu=7, totalDays=7')

  // Test 4 (Sprint 6.6.3a): фин-неделя 16-22 мая через getFinancialWeek
  // проверяет что totalDays=7 (а не 8) независимо от TZ процесса.
  console.log('\n=== Test 4: Фин.неделя от пятницы 22.05 ===')
  const friday22 = new Date('2026-05-22T08:00:00.000Z')
  const fw = getFinancialWeek(friday22)
  console.log('from:', fw.from.toISOString(), '/ to:', fw.to.toISOString())
  const r4 = await getMaterialCostForRange(fw.from, fw.to, [...REVENUE_STATUSES])
  console.log('Result:', r4)
  console.log('Expected: totalDays = 7 (Сб-Пт, 7 дней)')
  console.log('PASS:', r4.totalDays === 7 ? '✅' : `❌ got ${r4.totalDays}`)

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
