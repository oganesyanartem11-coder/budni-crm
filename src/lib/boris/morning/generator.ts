/**
 * Генератор утреннего брифинга Бориса (Спринт 7.16.B).
 *
 * Single-shot LLM-вызов на выбранной модели Бориса. Возвращает готовый текст для отправки
 * в TG плюс счётчики токенов (для расчёта стоимости в cron-роуте).
 */

import { getTextModelClient } from '@/lib/llm/text-client'
import { getBorisModel } from '@/lib/ai/models'
import { computeBorisCostUsd } from '@/lib/boris/metrics/cost'
import { getMorningSystemPrompt } from './system-prompt'
import type { MorningContext } from './context-builder'

const MAX_TOKENS = 1200

export interface GenerateMorningResult {
  content: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  model: string
  costUsd: number
}

export async function generateMorningBriefing(
  context: MorningContext,
  model?: string
): Promise<GenerateMorningResult> {
  const resolvedModel = model ?? getBorisModel()
  const client = getTextModelClient(resolvedModel)
  const system = getMorningSystemPrompt()

  const userMessage =
    `Контекст текущего МСК-дня (JSON):\n` +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```\n\n' +
    `Напиши утренний брифинг по строгой структуре из system-промпта. ` +
    `Только готовый текст, без преамбулы и комментариев.`

  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userMessage }],
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content')
  }

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cacheCreationInputTokens = response.usage.cache_creation_input_tokens ?? 0
  const cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0
  return {
    content: textBlock.text.trim(),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    model: resolvedModel,
    costUsd: computeBorisCostUsd(inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, resolvedModel),
  }
}
