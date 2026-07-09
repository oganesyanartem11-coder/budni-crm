import { prisma } from '../src/lib/db/prisma'
import { getIngredientsConsumptionForRange } from '../src/lib/db/queries/ingredients-consumption'
import { REVENUE_STATUSES } from '../src/lib/constants/order'
import { getFinancialWeek } from '../src/lib/utils/week'

async function main() {
  console.log('=== Test 1: 1900 год — без меню ===')
  const r1 = await getIngredientsConsumptionForRange(
    new Date('1900-01-01T00:00:00.000Z'),
    new Date('1900-01-07T20:59:59.999Z'),
    [...REVENUE_STATUSES]
  )
  console.log(
    'rows:', r1.rows.length,
    'totalCost:', r1.totalCost,
    'daysWithoutMenu:', r1.daysWithoutMenu,
    'totalDays:', r1.totalDays
  )
  console.log('Expected: rows=0, totalCost=0, daysWithoutMenu=7, totalDays=7')
  console.log(
    'PASS:',
    r1.rows.length === 0 && r1.daysWithoutMenu === 7 && r1.totalDays === 7 ? '✅' : '❌'
  )

  console.log('\n=== Test 2: фин.неделя 16-22 мая ===')
  const fw = getFinancialWeek(new Date('2026-05-22T08:00:00.000Z'))
  console.log('from:', fw.from.toISOString(), '/ to:', fw.to.toISOString())
  const r2 = await getIngredientsConsumptionForRange(fw.from, fw.to, [...REVENUE_STATUSES])
  console.log(
    'rows:', r2.rows.length,
    'totalCost:', r2.totalCost,
    'daysWithoutMenu:', r2.daysWithoutMenu,
    'totalDays:', r2.totalDays
  )
  console.log('Expected totalDays:', 7)
  console.log('Sort check (top-3 totalCost DESC):')
  for (const r of r2.rows.slice(0, 3)) {
    console.log(
      `  ${r.ingredientName}: ${r.totalNeeded.toFixed(2)} ${r.unit}, ${r.totalCost.toFixed(0)} ₽`
    )
  }

  console.log('\n=== Test 3: один день (вчера) ===')
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)
  const r3 = await getIngredientsConsumptionForRange(yesterday, yesterday, [...REVENUE_STATUSES])
  console.log(
    'rows:', r3.rows.length,
    'totalCost:', r3.totalCost,
    'daysWithoutMenu:', r3.daysWithoutMenu,
    'totalDays:', r3.totalDays
  )
  console.log('Expected totalDays: 1')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
