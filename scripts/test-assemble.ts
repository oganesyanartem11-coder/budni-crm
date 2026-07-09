import fs from 'node:fs'
import { prisma } from '../src/lib/db/prisma'
import { extractXlsxText, extractedToText } from '../src/lib/excel/menu-extractor'
import { parseMenuSchedule } from '../src/lib/llm/menu-schedule-parser'
import { generateRecipes } from '../src/lib/llm/recipe-generator'
import { assembleMenuImport, rollbackMenuImport } from '../src/lib/menu-import/assemble'

async function countAll(label: string) {
  const [menuImports, dishesDraft, ingredients, cycles, menuDays, menuDayDishes] = await Promise.all([
    prisma.menuImport.count(),
    prisma.dish.count({ where: { status: 'DRAFT' } }),
    prisma.ingredient.count(),
    prisma.menuCycle.count(),
    prisma.menuDay.count(),
    prisma.menuDayDish.count(),
  ])
  console.log(`[${label}]`, JSON.stringify({ menuImports, dishesDraft, ingredients, cycles, menuDays, menuDayDishes }))
}

async function main() {
  console.log('=== 0. Проверка БД ДО (dev должен быть чистым) ===')
  await countAll('before')
  console.log()

  console.log('=== 1. Pipeline 8.3 + 8.4: Excel → расписание → рецепты ===')
  const buf = fs.readFileSync('test-data/menu.xlsx')
  const sheets = extractXlsxText(buf)
  const text = extractedToText(sheets)
  const schedule = await parseMenuSchedule(text)

  const slotByDish = new Map<string, string>()
  for (const e of schedule.entries) {
    if (!slotByDish.has(e.dishName)) slotByDish.set(e.dishName, e.slot)
  }
  const dishes = schedule.uniqueDishes.map((name) => ({
    name,
    slot: slotByDish.get(name) ?? 'Доп.блюдо',
  }))
  console.log(`schedule: ${schedule.entries.length} entries, ${dishes.length} уникальных блюд, confidence=${schedule.confidence}`)

  const recipes = await generateRecipes({ dishes, existingIngredients: [] })
  console.log(`recipes: ${recipes.recipes.length}, confidence=${recipes.confidence}`)
  console.log()

  console.log('=== 2. assembleMenuImport (транзакция) ===')
  const t0 = Date.now()
  const result = await assembleMenuImport({
    source: 'EXCEL',
    rawText: text,
    confidence: schedule.confidence,
    reason: schedule.reason,
    entries: schedule.entries,
    uniqueDishes: schedule.uniqueDishes,
    recipes: recipes.recipes,
    userId: null,
  })
  console.log(`assemble took ${Date.now() - t0}ms`)
  console.log(JSON.stringify(result, null, 2))
  console.log()

  console.log('=== 3. Проверка БД ПОСЛЕ сборки ===')
  await countAll('after-assemble')
  console.log()

  console.log('=== 4. rollbackMenuImport ===')
  const t1 = Date.now()
  const rb = await rollbackMenuImport(result.menuImportId)
  console.log(`rollback took ${Date.now() - t1}ms`)
  console.log(JSON.stringify(rb, null, 2))
  console.log()

  console.log('=== 5. Проверка БД ПОСЛЕ отката (импорт-данные должны обнулиться) ===')
  await countAll('after-rollback')
  console.log()

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
