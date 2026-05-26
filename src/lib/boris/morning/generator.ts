/**
 * Генератор утреннего брифинга Бориса (Спринт 7.16.B).
 *
 * Single-shot LLM-вызов на Sonnet. Возвращает готовый текст для отправки
 * в TG плюс счётчики токенов (для расчёта стоимости в cron-роуте).
 */

import { getAnthropicClient } from '@/lib/llm/client'
import { getBorisModel } from '@/lib/ai/models'
import { getMorningSystemPrompt } from './system-prompt'
import type { MorningContext } from './context-builder'

const MAX_TOKENS = 1200

export interface GenerateMorningResult {
  content: string
  inputTokens: number
  outputTokens: number
}

export async function generateMorningBriefing(
  context: MorningContext,
  model?: string
): Promise<GenerateMorningResult> {
  const client = getAnthropicClient()
  const system = getMorningSystemPrompt()

  const userMessage =
    `Контекст текущего МСК-дня (JSON):\n` +
    '```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```\n\n' +
    `Напиши утренний брифинг по строгой структуре из system-промпта. ` +
    `Только готовый текст, без преамбулы и комментариев.`

  const response = await client.messages.create({
    model: model ?? getBorisModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userMessage }],
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content')
  }

  return {
    content: textBlock.text.trim(),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}
