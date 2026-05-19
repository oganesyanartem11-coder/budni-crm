import { getAnthropicClient } from './client'

// Генерация черновиков техкарт требует знаний кулинарии и понимания
// типичных пропорций — Haiku для этого слаб. Используем Opus локально,
// глобальный LLM_MODEL (Haiku для бота заявок) не трогаем.
const MODEL = 'claude-opus-4-7'

export type DishCategory =
  | 'SOUP'
  | 'MAIN'
  | 'GARNISH'
  | 'SALAD'
  | 'DESSERT'
  | 'DRINK'
  | 'BREAD_WHITE'
  | 'BREAD_DARK'
  | 'PORRIDGE'
  | 'EGGS'
  | 'PANCAKE'
  | 'OTHER'

export type DishUnit = 'PORTION' | 'LITER' | 'KG' | 'PIECE'

export interface GeneratedIngredient {
  name: string
  grams: number
}

export type CorrectionLevel = 'none' | 'light' | 'medium' | 'critical'

export interface GeneratedRecipe {
  // originalName — РОВНО как пришло на входе (ключ связи с расписанием на 8.5).
  // correctedName — что показывать шефу (исправленное или = original если правок нет).
  // correctionLevel + correctionNote — прозрачность: UI 8.6 показывает шефу что ИИ изменил.
  originalName: string
  correctedName: string
  correctionLevel: CorrectionLevel
  correctionNote: string
  category: DishCategory
  unit: DishUnit
  portionSize: number
  ingredients: GeneratedIngredient[]
}

export interface RecipeGenInput {
  dishes: Array<{ name: string; slot: string }>
  existingIngredients: string[]
}

export interface RecipeGenOutput {
  recipes: GeneratedRecipe[]
  confidence: number
  reason: string
  rawLlmResponse: string
}

const VALID_CATEGORIES: DishCategory[] = [
  'SOUP',
  'MAIN',
  'GARNISH',
  'SALAD',
  'DESSERT',
  'DRINK',
  'BREAD_WHITE',
  'BREAD_DARK',
  'PORRIDGE',
  'EGGS',
  'PANCAKE',
  'OTHER',
]

const VALID_UNITS: DishUnit[] = ['PORTION', 'LITER', 'KG', 'PIECE']

const VALID_CORRECTION_LEVELS: CorrectionLevel[] = ['none', 'light', 'medium', 'critical']

const DEFAULT_PORTION_BY_CATEGORY: Record<DishCategory, number> = {
  SOUP: 350,
  MAIN: 250,
  GARNISH: 150,
  SALAD: 100,
  DESSERT: 60,
  DRINK: 300,
  BREAD_WHITE: 40,
  BREAD_DARK: 40,
  PORRIDGE: 250,
  EGGS: 150,
  PANCAKE: 120,
  OTHER: 200,
}

export async function generateRecipes(input: RecipeGenInput): Promise<RecipeGenOutput> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты технолог кейтеринг-компании «Будни». По названию блюда и его слоту в меню составляешь типовую техническую карту: список ингредиентов с весом в граммах на одну порцию. Это ЧЕРНОВИК для шефа — он проверит и поправит.

Твоя задача — для каждого блюда из списка определить категорию, единицу выхода, размер порции и состав ингредиентов с граммовкой на одну порцию.

ПРАВИЛА:
1. Возвращай ВАЛИДНЫЙ JSON, ничего кроме JSON.
2. category — СТРОГО один из 12: SOUP, MAIN, GARNISH, SALAD, DESSERT, DRINK, BREAD_WHITE, BREAD_DARK, PORRIDGE, EGGS, PANCAKE, OTHER. Используй слот как подсказку: слот "Суп" → SOUP, "Салат" → SALAD, "Напиток" → DRINK, "Горячее" → обычно MAIN, "Доп.блюдо" → по смыслу названия (блинчик → PANCAKE, хлеб → BREAD_*). Неоднозначно → OTHER.
3. unit — СТРОГО один из: PORTION, LITER, KG, PIECE. По умолчанию PORTION; супы и компоты обычно LITER, гарниры и салаты KG, хлеб и блинчики PIECE.
4. portionSize — выход одной порции в граммах (мл для напитков): SOUP ~350, MAIN ~250, GARNISH ~150, SALAD ~100, DESSERT ~60, DRINK ~300, BREAD_WHITE ~40, BREAD_DARK ~40, PORRIDGE ~250, EGGS ~150, PANCAKE ~120, OTHER ~200.
5. Состав — типовой рецепт по названию: реалистичные ингредиенты и граммовки на одну порцию. Сумма граммовок примерно соответствует выходу порции (при готовке вес меняется — точность не критична, это черновик).
6. Матчинг ингредиентов: тебе дан список существующих ингредиентов базы. Если ингредиент по смыслу совпадает с существующим — верни ИМЯ РОВНО как в списке (один-к-одному, не синоним, не склонение). Если такого нет — верни нормальное название (создастся новый).
7. grams — положительное число, вес ингредиента в одной порции.
8. Названия ингредиентов — нормальные русские в именительном падеже единственном числе ("Морковь", "Лук репчатый", "Говядина"), без брендов и уточнений сорта если не критично.
9. confidence 0..1 — общая уверенность в качестве сгенерированных рецептов. reason — кратко: сколько блюд обработал, что вызвало сомнение (НЕ перечисляй все составы).
10. originalName — верни РОВНО как блюдо названо во входном списке, символ-в-символ, со всеми опечатками и пробелами. Это ключ связи с расписанием, его трогать нельзя.
11. correctedName — если в названии очевидная ошибка (опечатка, лишние/двойные пробелы, кривая формулировка) — ИСПРАВЬ её здесь, верни чистое корректное название. Если название уже корректно — повтори originalName без изменений.
12. correctionLevel — оцени правку: "none" (не менял), "light" (опечатка, пробелы, регистр — смысл не изменился), "medium" (переформулировал для ясности, блюдо то же), "critical" (НЕ уверен в исправлении / возможно это разные блюда написаны похоже / рецептура вариативна — нужно подтверждение шефа).
13. correctionNote — кратко по-русски что именно изменил и почему. Формат "было → стало" если применимо. Если correctionLevel="none" — пустая строка.
14. Особый случай: если во входном списке встречаются похожие названия, которые МОГУТ быть одним блюдом написанным по-разному (напр. "Сырный" и "Сырный суп", "Жаркое из курицы и овощами" и "Жаркое из курицы и овощами в сливочном соусе") — НЕ объединяй их сам. Сгенерируй техкарту для каждого как есть, но пометь correctionLevel="critical" и в correctionNote укажи "возможно то же блюдо что <название> — нужно решение шефа".

Формат ответа:
{
  "recipes": [
    {
      "originalName": "...",
      "correctedName": "...",
      "correctionLevel": "none" | "light" | "medium" | "critical",
      "correctionNote": "...",
      "category": "SOUP" | "MAIN" | "GARNISH" | "SALAD" | "DESSERT" | "DRINK" | "BREAD_WHITE" | "BREAD_DARK" | "PORRIDGE" | "EGGS" | "PANCAKE" | "OTHER",
      "unit": "PORTION" | "LITER" | "KG" | "PIECE",
      "portionSize": число,
      "ingredients": [
        {"name": "...", "grams": число}
      ]
    }
  ],
  "confidence": 0.0-1.0,
  "reason": "..."
}`

  const dishesList = input.dishes.map((d) => `- ${d.name} [слот: ${d.slot}]`).join('\n')
  const ingredientsList =
    input.existingIngredients.length > 0
      ? input.existingIngredients.map((n) => `- ${n}`).join('\n')
      : '(пусто)'

  const userPrompt = `Блюда для составления техкарт:
${dishesList}

Существующие ингредиенты базы (матчить по смыслу, имя ровно как здесь, если совпадает):
${ingredientsList}

Составь техкарты. Верни JSON.`

  const startTime = Date.now()

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const elapsed = Date.now() - startTime
  console.log(`[LLM] recipe generation took ${elapsed}ms`)

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content')
  }
  const rawLlmResponse = textBlock.text

  const jsonText = rawLlmResponse
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.error('[LLM] recipe-generator failed to parse JSON, raw:', rawLlmResponse)
    return {
      recipes: [],
      confidence: 0,
      reason: 'LLM вернул невалидный JSON',
      rawLlmResponse,
    }
  }

  const p = parsed as Record<string, unknown>
  const rawRecipes = Array.isArray(p.recipes) ? (p.recipes as unknown[]) : []

  const recipes: GeneratedRecipe[] = rawRecipes.flatMap((raw) => {
    const r = raw as Record<string, unknown>
    // originalName — ключ связи с расписанием. Без него запись бесполезна.
    // НЕ .trim() — оригинал должен дойти символ-в-символ, иначе матчинг сломается.
    if (typeof r.originalName !== 'string' || r.originalName === '') return []

    const correctedName =
      typeof r.correctedName === 'string' && r.correctedName.trim() !== ''
        ? r.correctedName.trim()
        : r.originalName

    const correctionLevel: CorrectionLevel = VALID_CORRECTION_LEVELS.includes(
      r.correctionLevel as CorrectionLevel
    )
      ? (r.correctionLevel as CorrectionLevel)
      : 'none'

    const correctionNote = typeof r.correctionNote === 'string' ? r.correctionNote : ''

    const category: DishCategory = VALID_CATEGORIES.includes(r.category as DishCategory)
      ? (r.category as DishCategory)
      : 'OTHER'
    const unit: DishUnit = VALID_UNITS.includes(r.unit as DishUnit)
      ? (r.unit as DishUnit)
      : 'PORTION'
    const portionSize =
      typeof r.portionSize === 'number' && r.portionSize > 0
        ? r.portionSize
        : DEFAULT_PORTION_BY_CATEGORY[category]

    const rawIngredients = Array.isArray(r.ingredients) ? (r.ingredients as unknown[]) : []
    const ingredients: GeneratedIngredient[] = rawIngredients.flatMap((rawI) => {
      const i = rawI as Record<string, unknown>
      if (
        typeof i.name === 'string' &&
        i.name.trim() !== '' &&
        typeof i.grams === 'number' &&
        i.grams > 0
      ) {
        return [{ name: i.name.trim(), grams: i.grams }]
      }
      return []
    })

    return [
      {
        originalName: r.originalName,
        correctedName,
        correctionLevel,
        correctionNote,
        category,
        unit,
        portionSize,
        ingredients,
      },
    ]
  })

  return {
    recipes,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    reason: typeof p.reason === 'string' ? p.reason : '',
    rawLlmResponse,
  }
}
