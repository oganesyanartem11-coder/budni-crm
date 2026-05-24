import { prismaDirect } from '@/lib/db/prisma-direct'
import type {
  DishCategory,
  DishUnit,
  MealType,
  MenuImportSource,
} from '@prisma/client'
import type { ScheduleEntry } from '@/lib/llm/menu-schedule-parser'
import type { GeneratedRecipe } from '@/lib/llm/recipe-generator'
import { getMondayOfWeek, getSundayOfWeek } from '@/lib/utils/week'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface AssembleInput {
  source: MenuImportSource
  rawText: string
  confidence: number
  reason: string
  entries: ScheduleEntry[]
  // Достоверный список имён блюд из 8.3 (parseMenuSchedule). Кириллица как в Excel.
  // Это источник правды для связи Dish ↔ MenuDayDish (recipe.originalName ненадёжен —
  // LLM иногда галлюцинирует, поэтому ключом служит uniqueDishes, не recipe.originalName).
  uniqueDishes: string[]
  recipes: GeneratedRecipe[]
  userId: string | null
  // Если передан — переиспользуем уже существующий MenuImport (плейсхолдер от
  // оркестратора run-import.ts). Без него — создаётся новый, как было в 8.5b.
  existingMenuImportId?: string
}

export interface AssembleResult {
  menuImportId: string
  dishesCreated: number
  ingredientsCreated: number
  ingredientsMatched: number
  cyclesCreated: number
  menuDaysCreated: number
  menuDayDishesCreated: number
  unmatched: string[]
}

export interface RollbackResult {
  deleted: boolean
  dishesDeleted: number
  cyclesDeleted: number
}

const DAY_TO_DOW: Record<string, number> = {
  'Понедельник': 1,
  'Вторник': 2,
  'Среда': 3,
  'Четверг': 4,
  'Пятница': 5,
  'Суббота': 6,
  'Воскресенье': 7,
}

const MEAL_TO_TYPE: Record<string, MealType> = {
  'обед': 'LUNCH',
  'ужин': 'DINNER',
}

// Следующий MSK-понедельник от now() (если сегодня уже понедельник — следующий).
// Реализация через getMondayOfWeek(now + 7d): берём момент через неделю и
// нормализуем до MSK-полночи понедельника той недели. Это всегда даёт следующий
// MSK-понедельник независимо от того, какой сегодня день недели.
function nextMondayFromNow(): Date {
  return getMondayOfWeek(new Date(Date.now() + 7 * DAY_MS))
}

// "YYYY-MM-DD" в MSK-календаре из произвольной UTC-точки.
function mskIsoDate(d: Date): string {
  return new Date(d.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

// Сборка одного импорта меню (фото или Excel) в БД одной транзакцией.
// Создаёт MenuImport + новые Ingredient (с placeholder ценой 0) + Dish(DRAFT) +
// DishIngredient + MenuCycle(по неделе) + MenuDay(уникальная по week|day|meal) +
// MenuDayDish (по каждому entry расписания).
// Связь "цикл принадлежит этому импорту" восстанавливается через Dish.menuImportId
// (схема 8.5a: MenuImport.menuCycleId одиночный, у нас может быть >1 недели).
export async function assembleMenuImport(input: AssembleInput): Promise<AssembleResult> {
  return prismaDirect.$transaction(
    async (tx) => {
      // 1. MenuImport — либо обновляем плейсхолдер от оркестратора, либо создаём новый.
      const mi = input.existingMenuImportId
        ? await tx.menuImport.update({
            where: { id: input.existingMenuImportId },
            data: {
              source: input.source,
              status: 'DRAFT',
              rawText: input.rawText,
              confidence: input.confidence,
              reason: input.reason,
              createdById: input.userId,
            },
          })
        : await tx.menuImport.create({
            data: {
              source: input.source,
              status: 'DRAFT',
              rawText: input.rawText,
              confidence: input.confidence,
              reason: input.reason,
              createdById: input.userId,
            },
          })

      // 2. Ингредиенты: матчинг существующих по name; новые создаём с pricePerUnit=0
      // (AI цен не знает — placeholder, менеджер проставит) и пишем первую запись priceHistory.
      // Единица KG как нейтральный дефолт — AI единицу не возвращает; шеф поправит.
      const uniqueIngredientNames = new Set<string>()
      for (const r of input.recipes) for (const i of r.ingredients) uniqueIngredientNames.add(i.name)

      const ingredientIdByName = new Map<string, string>()
      let ingredientsMatched = 0
      let ingredientsCreated = 0

      for (const name of uniqueIngredientNames) {
        const existing = await tx.ingredient.findUnique({ where: { name } })
        if (existing) {
          ingredientIdByName.set(name, existing.id)
          ingredientsMatched++
          continue
        }
        const created = await tx.ingredient.create({
          data: { name, unit: 'KG', pricePerUnit: 0 },
        })
        await tx.ingredientPriceHistory.create({
          data: {
            ingredientId: created.id,
            price: 0,
            changedBy: input.userId ?? undefined,
          },
        })
        ingredientIdByName.set(name, created.id)
        ingredientsCreated++
      }

      // 3. Блюда: источник правды — input.uniqueDishes (из 8.3, кириллица как в Excel).
      // recipe.originalName/correctedName используем только для содержания техкарты,
      // НЕ как ключ связи — LLM иногда галлюцинирует originalName (см. unmatched-кейс).
      //
      // Двухуровневая Map<имя, recipe>: приоритет originalName, фолбэк correctedName.
      // Если LLM исказил originalName, но correctedName вернул правильно — фолбэк спасёт.
      const recipeByName = new Map<string, GeneratedRecipe>()
      for (const r of input.recipes) {
        if (!recipeByName.has(r.originalName)) recipeByName.set(r.originalName, r)
        if (!recipeByName.has(r.correctedName)) recipeByName.set(r.correctedName, r)
      }

      // Строгая защита: имена из uniqueDishes, для которых не нашлось ни одного recipe.
      // В норме пусто (recipe-generator должен вернуть техкарту на каждое имя).
      const missingRecipes: string[] = []
      for (const name of input.uniqueDishes) {
        if (!recipeByName.has(name)) missingRecipes.push(name)
      }
      if (input.recipes.length !== input.uniqueDishes.length || missingRecipes.length > 0) {
        throw new Error(
          `Генерация техкарт неполна: recipes=${input.recipes.length}, ожидалось ${input.uniqueDishes.length}. Без техкарт: ${JSON.stringify(missingRecipes)}`
        )
      }

      // Создаём Dish перебором uniqueDishes (НЕ recipes). Ключ Map dishByKey —
      // имя из uniqueDishes (кириллица, достоверно). Это то, что потом матчится с entry.dishName.
      const dishByKey = new Map<string, { id: string; category: DishCategory }>()
      const seenName = new Set<string>()
      let dishesCreated = 0

      for (const name of input.uniqueDishes) {
        if (seenName.has(name)) continue
        seenName.add(name)

        const recipe = recipeByName.get(name)
        if (!recipe) continue // defense-in-depth (проверка выше уже отсекла)

        const dish = await tx.dish.create({
          data: {
            name: recipe.correctedName,
            category: recipe.category as DishCategory,
            unit: recipe.unit as DishUnit,
            portionSize: recipe.portionSize,
            status: 'DRAFT',
            // originalName в БД пишем тот, что вернул LLM — для прозрачности шефу видна
            // любая галлюцинация (UI 8.6 покажет diff originalName vs uniqueDish-имя).
            originalName: recipe.originalName,
            correctedName: recipe.correctedName,
            correctionLevel: recipe.correctionLevel,
            correctionNote: recipe.correctionNote,
            menuImportId: mi.id,
            ingredients: {
              create: recipe.ingredients.map((ing) => ({
                ingredientId: ingredientIdByName.get(ing.name)!,
                bruttoGrams: ing.grams,
                nettoGrams: ing.grams,
              })),
            },
          },
        })
        dishByKey.set(name, { id: dish.id, category: dish.category })
        dishesCreated++
      }

      // 4. MenuCycle по уникальным неделям. Все циклы — ближайший будущий понедельник
      // + (week-1)*7 дней. Даты — заглушка, ADMIN перезадаст при утверждении.
      const baseMonday = nextMondayFromNow()
      const weeks = Array.from(new Set(input.entries.map((e) => e.week))).sort((a, b) => a - b)
      const cycleIdByWeek = new Map<number, string>()
      let cyclesCreated = 0

      for (const week of weeks) {
        const from = new Date(baseMonday.getTime() + (week - 1) * 7 * DAY_MS)
        const to = getSundayOfWeek(from)
        const name = `AI-импорт неделя ${week} (${mskIsoDate(from)})`
        const cycle = await tx.menuCycle.create({
          data: { name, validFrom: from, validTo: to, status: 'DRAFT' },
        })
        cycleIdByWeek.set(week, cycle.id)
        cyclesCreated++
      }

      // 5. MenuDay по уникальным (week, day, meal). У MenuDay уникальный индекс
      // (menuCycleId, dayOfWeek, mealType) — на одну неделю-день-приём один MenuDay,
      // все блюда этого приёма идут в него как MenuDayDish.
      const menuDayKey = (week: number, day: string, meal: string) => `${week}|${day}|${meal}`
      const menuDayIdByKey = new Map<string, string>()
      let menuDaysCreated = 0

      const uniqueDayKeys = new Set<string>()
      for (const e of input.entries) uniqueDayKeys.add(menuDayKey(e.week, e.day, e.meal))

      for (const key of uniqueDayKeys) {
        const [weekStr, day, meal] = key.split('|')
        const week = Number(weekStr)
        const cycleId = cycleIdByWeek.get(week)
        const dow = DAY_TO_DOW[day]
        const mealType = MEAL_TO_TYPE[meal]
        if (!cycleId || !dow || !mealType) continue // защита от мусорных пар

        const md = await tx.menuDay.create({
          data: { menuCycleId: cycleId, dayOfWeek: dow, mealType },
        })
        menuDayIdByKey.set(key, md.id)
        menuDaysCreated++
      }

      // 6. MenuDayDish: для каждого entry расписания. dishId резолвится по
      // entry.dishName ↔ dishByKey-имя (обе стороны — кириллица из 8.3, строгое равенство).
      // slotCategory — категория самого dish. unmatched теоретически невозможен после
      // проверки missingRecipes выше, но остаётся defensive (entries[].dishName всегда
      // должно быть ∈ uniqueDishes по контракту 8.3).
      const unmatched: string[] = []
      let menuDayDishesCreated = 0

      for (const entry of input.entries) {
        const dish = dishByKey.get(entry.dishName)
        if (!dish) {
          unmatched.push(entry.dishName)
          continue
        }
        const menuDayId = menuDayIdByKey.get(menuDayKey(entry.week, entry.day, entry.meal))
        if (!menuDayId) {
          unmatched.push(entry.dishName)
          continue
        }
        await tx.menuDayDish.create({
          data: { menuDayId, dishId: dish.id, slotCategory: dish.category },
        })
        menuDayDishesCreated++
      }

      return {
        menuImportId: mi.id,
        dishesCreated,
        ingredientsCreated,
        ingredientsMatched,
        cyclesCreated,
        menuDaysCreated,
        menuDayDishesCreated,
        unmatched,
      }
    },
    { timeout: 30000 }
  )
}

// Полный откат импорта: удаляем все артефакты в обратном порядке зависимостей.
// Циклы импорта определяем через Dish.menuImportId → MenuDayDish → MenuDay → MenuCycle
// (схема не хранит обратную связь "циклы этого импорта" напрямую).
// Ингредиенты НЕ трогаем (могли существовать до импорта; осиротевшие — отдельный вопрос).
export async function rollbackMenuImport(menuImportId: string): Promise<RollbackResult> {
  return prismaDirect.$transaction(
    async (tx) => {
      const mi = await tx.menuImport.findUnique({ where: { id: menuImportId } })
      if (!mi) return { deleted: false, dishesDeleted: 0, cyclesDeleted: 0 }

      const dishes = await tx.dish.findMany({
        where: { menuImportId },
        select: { id: true },
      })
      const dishIds = dishes.map((d) => d.id)

      // Циклы, в которых задействованы блюда импорта.
      const cycles = await tx.menuCycle.findMany({
        where: { days: { some: { dishes: { some: { dishId: { in: dishIds } } } } } },
        select: { id: true },
      })
      const cycleIds = cycles.map((c) => c.id)

      // Удаляем циклы — каскадно уйдут MenuDay (onDelete:Cascade) и MenuDayDish
      // (MenuDayDish.menuDayId → MenuDay onDelete:Cascade).
      let cyclesDeleted = 0
      if (cycleIds.length > 0) {
        const r = await tx.menuCycle.deleteMany({ where: { id: { in: cycleIds } } })
        cyclesDeleted = r.count
      }

      // Защита: если остались MenuDayDish, ссылающиеся на наши блюда в чужих циклах
      // (MenuDayDish.dishId → Dish без cascade), удаляем явно перед Dish.
      await tx.menuDayDish.deleteMany({ where: { dishId: { in: dishIds } } })

      // Удаляем блюда — DishIngredient уйдёт каскадно (onDelete:Cascade).
      const delDishes = await tx.dish.deleteMany({ where: { menuImportId } })

      await tx.menuImport.delete({ where: { id: menuImportId } })

      return {
        deleted: true,
        dishesDeleted: delDishes.count,
        cyclesDeleted,
      }
    },
    { timeout: 30000 }
  )
}

