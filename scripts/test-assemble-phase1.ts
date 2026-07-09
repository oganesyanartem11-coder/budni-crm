import fs from 'node:fs'
import { extractXlsxText, extractedToText } from '../src/lib/excel/menu-extractor'
import { parseMenuSchedule } from '../src/lib/llm/menu-schedule-parser'
import { generateRecipes } from '../src/lib/llm/recipe-generator'

const INPUT_PATH = 'test-data/menu.xlsx'
const OUTPUT_PATH = 'test-data/assemble-input.json'

async function main() {
  console.log('=== ФАЗА 1: пайплайн 8.3 + 8.4 (БД не трогаем) ===')
  console.log()

  const buf = fs.readFileSync(INPUT_PATH)
  const sheets = extractXlsxText(buf)
  const text = extractedToText(sheets)
  console.log(`extractXlsxText: ${sheets.length} листов, текст ${text.length} символов`)

  const t1 = Date.now()
  const schedule = await parseMenuSchedule(text)
  console.log(`parseMenuSchedule: ${Date.now() - t1}ms, entries=${schedule.entries.length}, uniqueDishes=${schedule.uniqueDishes.length}, confidence=${schedule.confidence}`)

  const slotByDish = new Map<string, string>()
  for (const e of schedule.entries) {
    if (!slotByDish.has(e.dishName)) slotByDish.set(e.dishName, e.slot)
  }
  const dishes = schedule.uniqueDishes.map((name) => ({
    name,
    slot: slotByDish.get(name) ?? 'Доп.блюдо',
  }))

  const t2 = Date.now()
  const recipes = await generateRecipes({ dishes, existingIngredients: [] })
  console.log(`generateRecipes: ${Date.now() - t2}ms, recipes=${recipes.recipes.length}, confidence=${recipes.confidence}`)

  const payload = {
    source: 'EXCEL' as const,
    rawText: text,
    confidence: schedule.confidence,
    reason: schedule.reason,
    entries: schedule.entries,
    uniqueDishes: schedule.uniqueDishes,
    recipes: recipes.recipes,
    userId: null as string | null,
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2))

  const stats = fs.statSync(OUTPUT_PATH)
  console.log(`сохранено: ${OUTPUT_PATH}, ${stats.size} байт`)
  console.log()
  console.log('Готово. Запусти phase2.')
}

main().catch((err) => {
  console.error('FATAL phase1:', err)
  process.exit(1)
})
