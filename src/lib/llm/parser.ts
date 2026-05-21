import { getAnthropicClient } from './client'
import { getInboxModel } from '@/lib/ai/models'

export type ParsedResponseType = 'numeric' | 'cancellation_intent' | 'question' | 'noise'

export type ToneLabel = 'neutral' | 'rude' | 'thanks' | 'urgent'

export interface ParsedItem {
  locationId: string
  locationName: string
  portions: number
}

export interface ParsedResponse {
  type: ParsedResponseType
  items: ParsedItem[]
  confidence: number
  reason: string
  toneLabel: ToneLabel
  rawClientText: string
  rawLlmResponse: string
}

export interface ParseInput {
  clientText: string
  clientName: string
  mealTypeRu: string
  locations: Array<{
    id: string
    name: string
    aliases: string[]
  }>
  recentOrders: Array<{
    date: string
    locationName: string
    portions: number
  }>
}

const VALID_TYPES: ParsedResponseType[] = ['numeric', 'cancellation_intent', 'question', 'noise']
const VALID_TONES: ToneLabel[] = ['neutral', 'rude', 'thanks', 'urgent']

export async function parseClientResponse(input: ParseInput): Promise<ParsedResponse> {
  const client = getAnthropicClient()

  const systemPrompt = `Ты — парсер ответов клиентов кейтеринг-компании "Будни".
Клиенты — юрлица. Каждый день они отвечают на вопрос "сколько порций на завтра?" свободным текстом.
Твоя задача — извлечь структуру: для каждой точки доставки определить количество порций.

ПРАВИЛА:
1. Возвращай ВАЛИДНЫЙ JSON, ничего кроме JSON.
2. Если клиент назвал точку синонимом (см. aliases) — используй каноническое название и id.
3. Если в тексте нет цифр (вопрос, жалоба, общение) — type="question" или "noise".
4. Если клиент даёт понять что заказа не будет ("не нужно", "праздник", "выходной", "0") — type="cancellation_intent".
5. Confidence 0..1: 1 — полная уверенность, ниже 0.8 — есть сомнения.
6. Reason — короткое объяснение что распознал и почему такой confidence (НЕ повторяй сам ответ).
7. ToneLabel — оценка тона клиента: "rude" (грубо), "thanks" (благодарность), "urgent" (срочно), "neutral" (нейтрально).

Формат ответа:
{
  "type": "numeric" | "cancellation_intent" | "question" | "noise",
  "items": [{"locationId": "...", "locationName": "...", "portions": число}],
  "confidence": 0.0-1.0,
  "reason": "...",
  "toneLabel": "neutral" | "rude" | "thanks" | "urgent"
}`

  const userPrompt = `Клиент: ${input.clientName}
Спрашиваем: сколько порций ${input.mealTypeRu} на завтра?

Точки доставки клиента:
${input.locations
  .map(
    (l) =>
      `- id="${l.id}", название="${l.name}"${
        l.aliases.length > 0 ? `, синонимы: ${l.aliases.join(', ')}` : ''
      }`
  )
  .join('\n')}

Последние 5 заказов клиента:
${
  input.recentOrders.length > 0
    ? input.recentOrders.map((o) => `- ${o.date}: ${o.locationName} — ${o.portions} порций`).join('\n')
    : '(пусто, новый клиент)'
}

Ответ клиента: "${input.clientText}"

Распознай структуру. Верни JSON.`

  const startTime = Date.now()

  const response = await client.messages.create({
    model: getInboxModel(),
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const elapsed = Date.now() - startTime
  console.log(`[LLM] parse took ${elapsed}ms`)

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
    console.error('[LLM] failed to parse JSON, raw:', rawLlmResponse)
    return {
      type: 'noise',
      items: [],
      confidence: 0,
      reason: 'LLM вернул невалидный JSON',
      toneLabel: 'neutral',
      rawClientText: input.clientText,
      rawLlmResponse,
    }
  }

  const p = parsed as Record<string, unknown>
  const rawItems = Array.isArray(p.items) ? (p.items as unknown[]) : []
  const items: ParsedItem[] = rawItems.flatMap((raw) => {
    const i = raw as Record<string, unknown>
    if (typeof i.locationId === 'string' && typeof i.portions === 'number' && i.portions >= 0) {
      return [{
        locationId: i.locationId,
        locationName: typeof i.locationName === 'string' ? i.locationName : '',
        portions: i.portions,
      }]
    }
    return []
  })

  return {
    type: VALID_TYPES.includes(p.type as ParsedResponseType) ? (p.type as ParsedResponseType) : 'noise',
    items,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    reason: typeof p.reason === 'string' ? p.reason : '',
    toneLabel: VALID_TONES.includes(p.toneLabel as ToneLabel) ? (p.toneLabel as ToneLabel) : 'neutral',
    rawClientText: input.clientText,
    rawLlmResponse,
  }
}
