import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/llm/client'
import { getVisionModel } from '@/lib/ai/models'

/**
 * MEGA-1 weekly-order parser. Извлекает заявку клиента на неделю (порции по дням
 * + постоянные диетические пометки) из фото таблицы или из текста.
 *
 * Vision tool_use паттерн скопирован с invoice-recognizer.ts (см. AGENTS.md:
 * ничего не предполагать про API). Модель — getVisionModel() (Sonnet 4.6),
 * единая точка резолва в src/lib/ai/models.ts.
 */

export type ParserInput =
  | { type: 'photo'; base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }
  | { type: 'text'; text: string }

export interface ParseResult {
  items: { date: string /* YYYY-MM-DD */; portions: number }[]
  dietaryNotes: string | null
  confidence: number // 0..1
  reason: string
}

const TOOL_NAME = 'submit_weekly_order'

// JSON Schema (НЕ Zod) — формат для Anthropic tool_use input_schema.
const WEEKLY_TOOL: Anthropic.Messages.Tool = {
  name: TOOL_NAME,
  description: 'Submit extracted weekly catering order (portions per day + dietary notes)',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description:
          'Массив { date, portions } по дням, где указано количество. Дни без количества НЕ включай.',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Дата дня в формате YYYY-MM-DD' },
            portions: { type: 'number', description: 'Количество порций на этот день' },
          },
          required: ['date', 'portions'],
        },
      },
      dietaryNotes: {
        type: ['string', 'null'],
        description:
          'Общие постоянные пометки клиента (например "всегда 2 без свинины"). null если нет.',
      },
      confidence: {
        type: 'number',
        description: 'Уверенность 0..1 (1 = всё читается чётко, <0.95 = есть сомнения).',
      },
      reason: { type: 'string', description: 'Краткое объяснение confidence (1-2 предложения).' },
    },
    required: ['items', 'dietaryNotes', 'confidence', 'reason'],
  },
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Форматирует UTC-инстант в YYYY-MM-DD по МСК-календарю.
 * weekStartDate — UTC-инстант МСК-полночи понедельника; сдвигаем +3ч и читаем
 * UTC-компоненты (MSK = UTC+3, без DST), как в src/lib/utils/week.ts и msk-window.ts.
 */
function toMskDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + MSK_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function buildSystemPrompt(clientName: string, monday: string, sunday: string): string {
  return `Ты — ассистент извлечения данных из заявок клиентов кейтеринг-сервиса «Будни». Клиент ${clientName} прислал заявку на следующую календарную неделю (Пн ${monday} — Вс ${sunday}, МСК).

Извлеки:
- items: массив { date, portions } для каждого дня где указано количество. ВАЖНО: дни без количества (выходные, серая заливка, пропуски) — НЕ включай в items.
- dietaryNotes: общие постоянные пометки клиента (например "всегда 2 без свинины", "без морепродуктов"). Если нет — null.
- confidence: твоя уверенность 0..1 (1 = всё читается чётко без сомнений, <0.95 = есть хоть одна неоднозначная цифра / нечёткая ячейка / сомнения).
- reason: краткое объяснение confidence (1-2 предложения).

Все даты в items должны попадать в диапазон ${monday}—${sunday}. Если в исходнике даты вне этого диапазона — confidence ≤0.8 и опиши в reason.`
}

function fallback(detail: string): ParseResult {
  return { items: [], dietaryNotes: null, confidence: 0, reason: `parser failed: ${detail}` }
}

export async function parseWeeklySubmission(
  input: ParserInput,
  context: { weekStartDate: Date /* nearest Monday MSK */; clientName: string }
): Promise<ParseResult> {
  const monday = toMskDateString(context.weekStartDate)
  const sunday = toMskDateString(new Date(context.weekStartDate.getTime() + 6 * DAY_MS))
  const systemPrompt = buildSystemPrompt(context.clientName, monday, sunday)

  const instruction =
    input.type === 'photo'
      ? `Распознай таблицу-заявку на этом фото и вызови ${TOOL_NAME}.`
      : `Разбери эту текстовую заявку и вызови ${TOOL_NAME}.`

  const content: Anthropic.Messages.ContentBlockParam[] =
    input.type === 'photo'
      ? [
          {
            type: 'image',
            source: { type: 'base64', media_type: input.mediaType, data: input.base64 },
          },
          { type: 'text', text: instruction },
        ]
      : [{ type: 'text', text: `${input.text}\n\n${instruction}` }]

  try {
    const client = getAnthropicClient()
    const response = await client.messages.create({
      model: getVisionModel(),
      max_tokens: 2048,
      system: systemPrompt,
      tools: [WEEKLY_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content }],
    })

    const toolUse = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )
    if (!toolUse || toolUse.name !== TOOL_NAME) {
      return fallback(`no tool_use block; stop_reason=${response.stop_reason}`)
    }

    const raw = toolUse.input as Partial<ParseResult> | null | undefined
    if (!raw || typeof raw !== 'object') {
      return fallback('tool_use input is not an object')
    }
    if (!Array.isArray(raw.items)) {
      return fallback('tool_use input missing items array')
    }
    if (typeof raw.confidence !== 'number' || Number.isNaN(raw.confidence)) {
      return fallback('tool_use input missing numeric confidence')
    }

    const items = raw.items
      .filter(
        (it): it is { date: string; portions: number } =>
          !!it &&
          typeof it === 'object' &&
          typeof (it as { date?: unknown }).date === 'string' &&
          typeof (it as { portions?: unknown }).portions === 'number'
      )
      .map((it) => ({ date: it.date, portions: it.portions }))

    return {
      items,
      dietaryNotes: typeof raw.dietaryNotes === 'string' ? raw.dietaryNotes : null,
      confidence: raw.confidence,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return fallback(detail)
  }
}
