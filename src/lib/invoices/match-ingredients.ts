import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/llm/client'
import { getVisionModel } from '@/lib/ai/models'
import type { RecognizedInvoiceLine } from '@/lib/llm/invoice-recognizer'

export type MatchAction = 'MATCHED_EXISTING' | 'CREATED_NEW' | 'SKIPPED'
export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export type MatchResult = {
  matchedIngredientId: string | null
  action: MatchAction
  confidence: MatchConfidence
  context: string
}

export type ExistingIngredient = {
  id: string
  name: string
  unit: 'KG' | 'L' | 'PCS'
  brandVariants?: unknown[]
}

const MATCH_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_matches',
  description: 'Submit ingredient matching decisions for invoice lines',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            matchedIngredientId: { type: ['string', 'null'] },
            action: { type: 'string', enum: ['MATCHED_EXISTING', 'CREATED_NEW', 'SKIPPED'] },
            confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            context: {
              type: 'string',
              description: 'Краткое объяснение решения (1-2 предложения)',
            },
          },
          required: ['matchedIngredientId', 'action', 'confidence', 'context'],
        },
      },
    },
    required: ['matches'],
  },
}

export async function matchInvoiceLines(input: {
  lines: RecognizedInvoiceLine[]
  existingIngredients: ExistingIngredient[]
}): Promise<MatchResult[]> {
  if (input.lines.length === 0) return []

  const client = getAnthropicClient()

  const existing = input.existingIngredients
    .map((i) => `- ${i.id} | ${i.name} | ${i.unit}`)
    .join('\n')

  const lines = input.lines
    .map((l, i) => `${i + 1}. ${l.rawName} (${l.quantity} ${l.unit})`)
    .join('\n')

  const systemPrompt = `Ты сопоставляешь строки накладной с существующими ингредиентами кейтеринг-компании.
Правила:
- Для каждой строки верни ОДНО из: MATCHED_EXISTING (нашёл совпадение в базе), CREATED_NEW (точно нет в базе, нужен новый), SKIPPED (не уверен — пропустить).
- В context кратко объясни решение: "тот же ингредиент, другая марка", "новый ингредиент — нет в базе", "сомнительно — пропускаем".
- confidence: HIGH (очевидно), MEDIUM (есть варианты), LOW (сильно сомневаешься — лучше SKIPPED).
- Бренды/марки часто отличаются (Огурец Пикадор → Огурец) — это MATCHED_EXISTING с MEDIUM confidence.
- Если matchedIngredientId не нужен (CREATED_NEW или SKIPPED) — верни null.
- Верни ровно столько matches, сколько строк (${input.lines.length}), в том же порядке.`

  const userPrompt = `Существующие ингредиенты:
${existing || '(пусто)'}

Строки накладной:
${lines}

Вызови submit_matches с массивом из ${input.lines.length} элементов.`

  const response = await client.messages.create({
    model: getVisionModel(), // тот же sonnet, текст-only хватит
    max_tokens: 4096,
    system: systemPrompt,
    tools: [MATCH_TOOL],
    tool_choice: { type: 'tool', name: 'submit_matches' },
    messages: [{ role: 'user', content: userPrompt }],
  })

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
  )
  if (!toolUse || toolUse.name !== 'submit_matches') {
    throw new Error(
      `LLM did not return tool_use for matches; stop_reason=${response.stop_reason}`
    )
  }

  const result = (toolUse.input as { matches?: MatchResult[] }).matches
  if (!Array.isArray(result)) {
    throw new Error('LLM returned non-array matches')
  }
  if (result.length !== input.lines.length) {
    throw new Error(
      `LLM returned ${result.length} matches, expected ${input.lines.length}`
    )
  }
  return result
}
