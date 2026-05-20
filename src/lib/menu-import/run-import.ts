import { prisma } from '@/lib/db/prisma'
import { extractXlsxText, extractedToText } from '@/lib/excel/menu-extractor'
import { parseMenuSchedule } from '@/lib/llm/menu-schedule-parser'
import { generateRecipes } from '@/lib/llm/recipe-generator'
import { assembleMenuImport } from './assemble'

export interface RunImportOpts {
  fileBuffer: Buffer
  userId: string | null
}

export interface RunImportHandle {
  menuImportId: string
}

// Оркестратор импорта меню из Excel (8.6a).
// Создаёт MenuImport-плейсхолдер СИНХРОННО (вызывающий получает id сразу),
// затем fire-and-forget запускает пайплайн: extract → parse → generate → assemble,
// пишет прогресс в БД на каждом этапе. UI читает MenuImport.progress polling'ом.
//
// Внимание: fire-and-forget IIFE может быть прервана на serverless (Vercel) — для прода
// обернём вызов в waitUntil() / unstable_after на уровне route handler'а (8.6b/c).
export async function runMenuImportFromExcel(opts: RunImportOpts): Promise<RunImportHandle> {
  const placeholder = await prisma.menuImport.create({
    data: {
      source: 'EXCEL',
      status: 'DRAFT',
      progress: 'EXTRACTING',
      rawText: '',
      confidence: null,
      reason: null,
      createdById: opts.userId,
    },
  })
  const menuImportId = placeholder.id
  console.log(`[run-import ${menuImportId}] created placeholder`)

  void (async () => {
    const t0 = Date.now()
    try {
      // a) EXTRACTING — уже стоит по дефолту от create.
      const tExtract = Date.now()
      const sheets = extractXlsxText(opts.fileBuffer)
      const rawText = extractedToText(sheets)
      console.log(
        `[run-import ${menuImportId}] EXTRACTING done in ${Date.now() - tExtract}ms (${sheets.length} sheets, ${rawText.length} chars)`
      )
      await prisma.menuImport.update({
        where: { id: menuImportId },
        data: { progress: 'PARSING_SCHEDULE', rawText },
      })

      // b) PARSING_SCHEDULE — LLM.
      const tParse = Date.now()
      const schedule = await parseMenuSchedule(rawText)
      console.log(
        `[run-import ${menuImportId}] PARSING_SCHEDULE done in ${Date.now() - tParse}ms (entries=${schedule.entries.length}, uniqueDishes=${schedule.uniqueDishes.length}, confidence=${schedule.confidence})`
      )
      await prisma.menuImport.update({
        where: { id: menuImportId },
        data: {
          progress: 'GENERATING_RECIPES',
          confidence: schedule.confidence,
          reason: schedule.reason,
        },
      })

      // c) GENERATING_RECIPES — LLM.
      const slotByDish = new Map<string, string>()
      for (const e of schedule.entries) {
        if (!slotByDish.has(e.dishName)) slotByDish.set(e.dishName, e.slot)
      }
      const dishes = schedule.uniqueDishes.map((name) => ({
        name,
        slot: slotByDish.get(name) ?? 'Доп.блюдо',
      }))

      const tGen = Date.now()
      const recipes = await generateRecipes({ dishes, existingIngredients: [] })
      console.log(
        `[run-import ${menuImportId}] GENERATING_RECIPES done in ${Date.now() - tGen}ms (recipes=${recipes.recipes.length}, confidence=${recipes.confidence})`
      )
      await prisma.menuImport.update({
        where: { id: menuImportId },
        data: { progress: 'ASSEMBLING' },
      })

      // d) ASSEMBLING — БД-транзакция. Передаём existingMenuImportId, чтобы
      // assembleMenuImport обновил наш плейсхолдер, а не создал новый.
      const tAsm = Date.now()
      const result = await assembleMenuImport({
        source: 'EXCEL',
        rawText,
        confidence: schedule.confidence,
        reason: schedule.reason,
        entries: schedule.entries,
        uniqueDishes: schedule.uniqueDishes,
        recipes: recipes.recipes,
        userId: opts.userId,
        existingMenuImportId: menuImportId,
      })
      console.log(
        `[run-import ${menuImportId}] ASSEMBLING done in ${Date.now() - tAsm}ms (dishes=${result.dishesCreated}, ingredients=${result.ingredientsCreated}, cycles=${result.cyclesCreated}, menuDays=${result.menuDaysCreated}, menuDayDishes=${result.menuDayDishesCreated}, unmatched=${result.unmatched.length})`
      )

      // e) READY.
      await prisma.menuImport.update({
        where: { id: menuImportId },
        data: { progress: 'READY' },
      })
      console.log(`[run-import ${menuImportId}] READY (total ${Date.now() - t0}ms)`)
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 2000)
      console.error(`[run-import ${menuImportId}] FAILED: ${msg}`)
      await prisma.menuImport
        .update({
          where: { id: menuImportId },
          data: { progress: 'FAILED', reason: msg },
        })
        .catch((updateErr) => {
          console.error(`[run-import ${menuImportId}] could not write FAILED: ${String(updateErr).slice(0, 500)}`)
        })
    }
  })()

  return { menuImportId }
}
