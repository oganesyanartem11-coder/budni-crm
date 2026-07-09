import fs from 'node:fs'
import { extractXlsxText, extractedToText } from '../src/lib/excel/menu-extractor'
import { parseMenuSchedule } from '../src/lib/llm/menu-schedule-parser'
import { generateRecipes } from '../src/lib/llm/recipe-generator'

const FAKE_EXISTING_INGREDIENTS = [
  'Картофель',
  'Говядина',
  'Свёкла',
  'Капуста',
  'Морковь',
  'Лук репчатый',
  'Рис',
  'Куриное филе',
  'Гречка',
  'Макароны',
  'Яйцо куриное',
  'Молоко',
  'Сметана',
  'Томатная паста',
]

async function main() {
  console.log('=== Шаг 1: парсим расписание из Excel (8.3) ===')
  const buf = fs.readFileSync('test-data/menu.xlsx')
  const sheets = extractXlsxText(buf)
  const text = extractedToText(sheets)
  const schedule = await parseMenuSchedule(text)

  // Для каждого uniqueDish — первый встретившийся в entries слот.
  const slotByDish = new Map<string, string>()
  for (const e of schedule.entries) {
    if (!slotByDish.has(e.dishName)) slotByDish.set(e.dishName, e.slot)
  }
  const dishes = schedule.uniqueDishes.map((name) => ({
    name,
    slot: slotByDish.get(name) ?? 'Доп.блюдо',
  }))

  console.log(`Получено ${dishes.length} уникальных блюд, расписание confidence=${schedule.confidence}`)
  console.log()

  console.log('=== Шаг 2: генерим черновики техкарт (8.4) ===')
  const result = await generateRecipes({
    dishes,
    existingIngredients: FAKE_EXISTING_INGREDIENTS,
  })

  console.log(JSON.stringify(result, null, 2))
  console.log()

  console.log('=== Сводка ===')
  console.log(`recipes total:           ${result.recipes.length} / ожидалось ${dishes.length}`)

  // Матчинг ключа: по originalName (символ-в-символ) — это связь с расписанием на 8.5.
  const inputNames = new Set(dishes.map((d) => d.name))
  const missingByOriginal = dishes
    .map((d) => d.name)
    .filter((n) => !result.recipes.some((r) => r.originalName === n))
  console.log(`missing по originalName: ${missingByOriginal.length}${missingByOriginal.length ? ' → ' + JSON.stringify(missingByOriginal) : ''}`)

  const unexpectedOriginals = result.recipes
    .map((r) => r.originalName)
    .filter((n) => !inputNames.has(n))
  console.log(`recipes с originalName вне входа: ${unexpectedOriginals.length}${unexpectedOriginals.length ? ' → ' + JSON.stringify(unexpectedOriginals) : ''}`)

  const emptyComposition = result.recipes.filter((r) => r.ingredients.length === 0)
  console.log(`recipes с пустым составом: ${emptyComposition.length}${emptyComposition.length ? ' → ' + JSON.stringify(emptyComposition.map((r) => r.originalName)) : ''}`)

  // Распределение по уровням правок.
  const levelCounts: Record<string, number> = { none: 0, light: 0, medium: 0, critical: 0 }
  for (const r of result.recipes) {
    levelCounts[r.correctionLevel] = (levelCounts[r.correctionLevel] ?? 0) + 1
  }
  console.log(
    `correctionLevel:         none=${levelCounts.none}, light=${levelCounts.light}, medium=${levelCounts.medium}, critical=${levelCounts.critical}`
  )

  // Полный список правок где level != 'none'.
  const corrections = result.recipes.filter((r) => r.correctionLevel !== 'none')
  if (corrections.length > 0) {
    console.log()
    console.log('=== Правки названий (level ≠ none) ===')
    for (const r of corrections) {
      console.log(`  "${r.originalName}" → "${r.correctedName}" [${r.correctionLevel}]: ${r.correctionNote}`)
    }
  }

  const existingSet = new Set(FAKE_EXISTING_INGREDIENTS)
  let matchedCount = 0
  let newCount = 0
  const newIngredients = new Set<string>()
  for (const r of result.recipes) {
    for (const i of r.ingredients) {
      if (existingSet.has(i.name)) matchedCount++
      else {
        newCount++
        newIngredients.add(i.name)
      }
    }
  }
  console.log()
  console.log(`ингредиентов сматчено:    ${matchedCount}`)
  console.log(`новых ингредиентов:       ${newCount} (уникальных: ${newIngredients.size})`)
  console.log(`confidence генератора:    ${result.confidence}`)
  console.log(`reason:                   ${result.reason}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
