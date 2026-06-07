import { getAnthropicClient } from './client'

// Распознавание меню требует vision и хороший OCR русского рукописного —
// глобальный LLM_MODEL (Haiku) слаб для этой задачи. Используем Opus локально,
// не меняя константу для остальных обёрток (parser, draft-generator).
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

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface RecognizedIngredient {
  name: string
  grams: number
  isAiGuess: boolean
}

export interface RecognizedDish {
  name: string
  category: DishCategory
  unit: DishUnit
  portionSize: number
  ingredients: RecognizedIngredient[]
  isAiGuessComposition: boolean
}

export interface MenuRecognizerInput {
  imageBase64: string
  imageMediaType: ImageMediaType
  existingIngredients: Array<{ id: string; name: string }>
}

export interface MenuRecognizerOutput {
  dishes: RecognizedDish[]
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

export async function recognizeMenu(input: MenuRecognizerInput): Promise<MenuRecognizerOutput> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты распознаёшь меню кейтеринг-компании «Будни» с фото или скана.
Меню рукописное или печатное, на русском. На фото могут быть таблица блюд с составом ингредиентов или только названия блюд.
Твоя задача — извлечь структуру: список блюд, для каждого блюда — категория, единица измерения выхода, размер порции и состав ингредиентов с весом в граммах.

ПРАВИЛА:
1. Возвращай ВАЛИДНЫЙ JSON, ничего кроме JSON.
2. category — СТРОГО один из: SOUP, MAIN, GARNISH, SALAD, DESSERT, DRINK, BREAD_WHITE, BREAD_DARK, PORRIDGE, EGGS, PANCAKE, OTHER. Если категория неоднозначна — OTHER.
3. unit — СТРОГО один из: PORTION, LITER, KG, PIECE. По умолчанию PORTION; супы и компоты обычно LITER, гарниры и салаты KG, хлеб и блинчики PIECE.
4. portionSize — выход одной порции в граммах (мл для напитков). Если на фото не указан — оцени по типичной норме: SOUP ~350, MAIN ~250, GARNISH ~150, SALAD ~100, DESSERT ~60, DRINK ~300, BREAD_WHITE ~40, BREAD_DARK ~40, PORRIDGE ~250, EGGS ~150, PANCAKE ~120, OTHER ~200.
5. Состав ингредиентов: если на фото есть состав — бери ОТТУДА (grams как указано, isAiGuess=false). Если на фото указано ТОЛЬКО название блюда без состава — дострой типовой состав по названию, КАЖДЫЙ такой ингредиент с isAiGuess=true, и для блюда isAiGuessComposition=true.
6. Матчинг ингредиентов: тебе дан список существующих ингредиентов базы. Если распознанный ингредиент по смыслу совпадает с существующим — верни ИМЯ РОВНО как в списке (один-к-одному, не синоним, не склонение). Если такого нет — верни как распознал (создастся новый).
7. grams — положительное число, вес одного ингредиента в одной порции блюда.
8. confidence 0..1 — уверенность в распознавании меню в целом. reason — кратко: что распознал, качество фото, что вызвало сомнение (НЕ перечисляй весь состав).

Формат ответа:
{
  "dishes": [
    {
      "name": "...",
      "category": "SOUP" | "MAIN" | "GARNISH" | "SALAD" | "DESSERT" | "DRINK" | "BREAD_WHITE" | "BREAD_DARK" | "PORRIDGE" | "EGGS" | "PANCAKE" | "OTHER",
      "unit": "PORTION" | "LITER" | "KG" | "PIECE",
      "portionSize": число,
      "ingredients": [
        {"name": "...", "grams": число, "isAiGuess": true | false}
      ],
      "isAiGuessComposition": true | false
    }
  ],
  "confidence": 0.0-1.0,
  "reason": "..."
}`

  const userPrompt = `Существующие ингредиенты базы (для матчинга, верни имя ровно как здесь, если по смыслу совпадает):
${
  input.existingIngredients.length > 0
    ? input.existingIngredients.map((i) => `- ${i.name}`).join('\n')
    : '(пусто)'
}

Распознай меню с изображения. Верни JSON.`

  const startTime = Date.now()

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.imageMediaType,
              data: input.imageBase64,
            },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ],
  })

  const elapsed = Date.now() - startTime
  console.log(
    `[LLM] menu recognition took ${elapsed}ms, ` +
      `stop_reason=${response.stop_reason ?? 'null'}, ` +
      `output_tokens=${response.usage.output_tokens ?? 0}`
  )

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
    console.error('[LLM] menu-recognizer failed to parse JSON, raw:', rawLlmResponse)
    console.error(
      `[menu-recognizer] JSON.parse failed (stop_reason=${response.stop_reason ?? 'null'}), raw response (first 2000 chars):`,
      rawLlmResponse?.slice(0, 2000)
    )
    return {
      dishes: [],
      confidence: 0,
      reason: 'LLM вернул невалидный JSON',
      rawLlmResponse,
    }
  }

  const p = parsed as Record<string, unknown>
  const rawDishes = Array.isArray(p.dishes) ? (p.dishes as unknown[]) : []

  const dishes: RecognizedDish[] = rawDishes.flatMap((raw) => {
    const d = raw as Record<string, unknown>
    if (typeof d.name !== 'string' || d.name.trim() === '') return []

    const category: DishCategory = VALID_CATEGORIES.includes(d.category as DishCategory)
      ? (d.category as DishCategory)
      : 'OTHER'
    const unit: DishUnit = VALID_UNITS.includes(d.unit as DishUnit)
      ? (d.unit as DishUnit)
      : 'PORTION'
    const portionSize =
      typeof d.portionSize === 'number' && d.portionSize > 0
        ? d.portionSize
        : DEFAULT_PORTION_BY_CATEGORY[category]

    const rawIngredients = Array.isArray(d.ingredients) ? (d.ingredients as unknown[]) : []
    const ingredients: RecognizedIngredient[] = rawIngredients.flatMap((rawI) => {
      const i = rawI as Record<string, unknown>
      if (
        typeof i.name === 'string' &&
        i.name.trim() !== '' &&
        typeof i.grams === 'number' &&
        i.grams > 0
      ) {
        return [
          {
            name: i.name.trim(),
            grams: i.grams,
            isAiGuess: typeof i.isAiGuess === 'boolean' ? i.isAiGuess : false,
          },
        ]
      }
      return []
    })

    return [
      {
        name: d.name.trim(),
        category,
        unit,
        portionSize,
        ingredients,
        isAiGuessComposition:
          typeof d.isAiGuessComposition === 'boolean' ? d.isAiGuessComposition : false,
      },
    ]
  })

  return {
    dishes,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    reason: typeof p.reason === 'string' ? p.reason : '',
    rawLlmResponse,
  }
}
