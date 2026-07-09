import fs from 'node:fs'
import { prismaDirect } from '../src/lib/db/prisma-direct'
import { assembleMenuImport, rollbackMenuImport } from '../src/lib/menu-import/assemble'
import type { AssembleInput } from '../src/lib/menu-import/assemble'

const INPUT_PATH = 'test-data/assemble-input.json'

async function countAll(label: string) {
  const [menuImports, dishesDraft, ingredients, cycles, menuDays, menuDayDishes] = await Promise.all([
    prismaDirect.menuImport.count(),
    prismaDirect.dish.count({ where: { status: 'DRAFT' } }),
    prismaDirect.ingredient.count(),
    prismaDirect.menuCycle.count(),
    prismaDirect.menuDay.count(),
    prismaDirect.menuDayDish.count(),
  ])
  console.log(`[${label}]`, JSON.stringify({ menuImports, dishesDraft, ingredients, cycles, menuDays, menuDayDishes }))
}

async function warmup(): Promise<number> {
  for (let i = 1; i <= 5; i++) {
    try {
      await prismaDirect.$queryRawUnsafe('SELECT 1')
      console.log(`warmup: попытка ${i} — OK`)
      return i
    } catch (e) {
      const msg = String(e).split('\n')[0]
      console.log(`warmup: попытка ${i} провалилась (${msg}) — жду 3с`)
      if (i < 5) await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw new Error('compute Neon не поднимается за 5 попыток — разбуди вручную в Console')
}

async function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Нет файла ${INPUT_PATH} — сначала запусти scripts/test-assemble-phase1.ts`)
    process.exit(1)
  }
  const input = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8')) as AssembleInput
  console.log(`загружен input: ${input.entries.length} entries, ${input.recipes.length} recipes, rawText ${input.rawText.length} символов`)
  console.log()

  console.log('=== WARMUP (будим compute прямым соединением) ===')
  const t0 = Date.now()
  const tries = await warmup()
  console.log(`warmup завершён за ${Date.now() - t0}ms (попыток: ${tries})`)
  console.log()

  console.log('=== Проверка БД ДО ===')
  await countAll('before')
  console.log()

  console.log('=== assembleMenuImport (транзакция через prismaDirect) ===')
  const t1 = Date.now()
  const result = await assembleMenuImport(input)
  console.log(`assemble took ${Date.now() - t1}ms`)
  console.log(JSON.stringify(result, null, 2))
  console.log()

  console.log('=== Проверка БД ПОСЛЕ сборки ===')
  await countAll('after-assemble')
  console.log()

  console.log('=== rollbackMenuImport ===')
  const t2 = Date.now()
  const rb = await rollbackMenuImport(result.menuImportId)
  console.log(`rollback took ${Date.now() - t2}ms`)
  console.log(JSON.stringify(rb, null, 2))
  console.log()

  console.log('=== Проверка БД ПОСЛЕ отката ===')
  await countAll('after-rollback')

  await prismaDirect.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL phase2:', e)
  await prismaDirect.$disconnect().catch(() => {})
  process.exit(1)
})
