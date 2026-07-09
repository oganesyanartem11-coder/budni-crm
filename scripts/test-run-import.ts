import fs from 'node:fs'
import { prisma } from '../src/lib/db/prisma'
import { runMenuImportFromExcel } from '../src/lib/menu-import/run-import'

const INPUT_PATH = 'test-data/menu.xlsx'
const POLL_INTERVAL_MS = 2000
const POLL_MAX_TICKS = 240 // ~8 min hard cap

function ts() {
  return new Date().toISOString().slice(11, 23)
}

async function main() {
  const buffer = fs.readFileSync(INPUT_PATH)
  console.log(`[${ts()}] starting runMenuImportFromExcel, file ${buffer.length} bytes`)

  const handle = await runMenuImportFromExcel({ fileBuffer: buffer, userId: null })
  console.log(`[${ts()}] got menuImportId=${handle.menuImportId} (placeholder created)`)

  let lastProgress = ''
  for (let i = 1; i <= POLL_MAX_TICKS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const mi = await prisma.menuImport.findUnique({
      where: { id: handle.menuImportId },
      select: { progress: true, reason: true, confidence: true },
    })
    if (!mi) {
      console.error(`[${ts()}] poll ${i}: menuImport исчез (откатился?)`)
      break
    }
    if (mi.progress !== lastProgress) {
      console.log(`[${ts()}] poll ${i}: progress=${mi.progress}${mi.confidence != null ? ' confidence=' + mi.confidence : ''}`)
      lastProgress = mi.progress
    }
    if (mi.progress === 'READY' || mi.progress === 'FAILED') {
      if (mi.progress === 'FAILED') {
        console.error(`[${ts()}] FAILED reason: ${mi.reason ?? '(нет)'}`)
      }
      break
    }
  }

  // Финальные счётчики артефактов импорта
  const [dishesCount, ingredientsCount, cyclesCount, menuDaysCount, menuDayDishesCount] =
    await Promise.all([
      prisma.dish.count({ where: { menuImportId: handle.menuImportId } }),
      prisma.ingredient.count(),
      prisma.menuCycle.count(),
      prisma.menuDay.count(),
      prisma.menuDayDish.count(),
    ])
  console.log(
    `[${ts()}] финальные счётчики:`,
    JSON.stringify({ dishesOfImport: dishesCount, ingredients: ingredientsCount, cycles: cyclesCount, menuDays: menuDaysCount, menuDayDishes: menuDayDishesCount })
  )

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error('FATAL:', err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
