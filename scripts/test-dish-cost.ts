/**
 * Smoke-test для queries/dish-cost.ts и queries/dish-cost-extremes.ts.
 * Запуск:
 *   cd /Users/macbook/Documents/CRM_FOOD && \
 *     npx dotenv -e .env.test -- npx tsx scripts/test-dish-cost.ts
 *
 * Не должен падать на пустой БД (пустые массивы / null).
 */

import { prisma } from '@/lib/db/prisma'
import {
  getDishCostNow,
  getDishCostList,
  getAvgDishCostPerPortion,
  getDishCostHistory,
  getDishUsageInMealSets,
} from '@/lib/db/queries/dish-cost'
import { getDishCostExtremes } from '@/lib/db/queries/dish-cost-extremes'

async function main() {
  const firstDish = await prisma.dish.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log('--- [A.1] getDishCostNow ---')
  if (!firstDish) {
    console.log('No dishes in DB. Skipping per-dish smoke.')
  } else {
    const cost = await getDishCostNow(firstDish.id)
    console.log(JSON.stringify(cost, null, 2))
  }

  console.log('\n--- [A.1] getDishCostList (no filter, first 3) ---')
  const list = await getDishCostList()
  console.log(`Total dishes: ${list.length}`)
  console.log(JSON.stringify(list.slice(0, 3), null, 2))

  console.log('\n--- [A.1] getDishCostList (mealType=LUNCH) ---')
  const listLunch = await getDishCostList({ mealType: 'LUNCH' })
  console.log(`LUNCH dishes: ${listLunch.length}`)

  console.log('\n--- [A.2] getAvgDishCostPerPortion (last 7d) ---')
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const avg = await getAvgDishCostPerPortion(weekAgo, now)
  console.log(JSON.stringify(avg, null, 2))

  console.log('\n--- [A.2] getAvgDishCostPerPortion (LUNCH, last 7d) ---')
  const avgLunch = await getAvgDishCostPerPortion(weekAgo, now, 'LUNCH')
  console.log(JSON.stringify(avgLunch, null, 2))

  console.log('\n--- [A.3] getDishCostHistory (first dish, last 30d) ---')
  if (firstDish) {
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const history = await getDishCostHistory(firstDish.id, monthAgo, now)
    console.log(`Events: ${history.length}`)
    console.log(JSON.stringify(history.slice(0, 3), null, 2))
  }

  console.log('\n--- [A.4] getDishCostExtremes (no filter) ---')
  const extremes = await getDishCostExtremes()
  console.log(JSON.stringify(extremes, null, 2))

  console.log('\n--- [A.4] getDishCostExtremes (LUNCH) ---')
  const extremesLunch = await getDishCostExtremes('LUNCH')
  console.log(JSON.stringify(extremesLunch, null, 2))

  console.log('\n--- [A.5] getDishUsageInMealSets ---')
  if (firstDish) {
    const usage = await getDishUsageInMealSets(firstDish.id)
    console.log(JSON.stringify(usage, null, 2))
  }

  console.log('\n--- [hotfix] per-row margin coverage ---')
  const withSell = list.filter(d => d.sellPrice !== null).length
  const withMargin = list.filter(d => d.marginPercent !== null).length
  const withGrowth = list.filter(d => d.growth30dPercent !== null).length
  const pct = (n: number) => (list.length > 0 ? Math.round((n / list.length) * 100) : 0)
  console.log(`total dishes: ${list.length}`)
  console.log(`with sellPrice: ${withSell} (${pct(withSell)}%)`)
  console.log(`with marginPercent: ${withMargin} (${pct(withMargin)}%)`)
  console.log(`with growth30dPercent: ${withGrowth} (${pct(withGrowth)}%)`)
  if (list.length > 0 && withMargin > 0) {
    const sample = list.find(d => d.marginPercent !== null)!
    console.log(`sample row: ${sample.dishName} sellPrice=${sample.sellPrice} margin=${sample.marginPercent}% growth30d=${sample.growth30dPercent}%`)
  }

  console.log('\nDONE')
}

main()
  .catch(e => {
    console.error('FATAL:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
