/**
 * generateSelfAnalysis — single-shot LLM-вызов для отчёта самоанализа Бориса.
 *
 * Принципиально НЕ через runAgentLoop: Боря тут не использует tools, отчёт
 * по предсобранному JSON. Single-shot + max_tokens 1500 — даёт стабильный
 * текстовый ответ без tool_use ветки.
 *
 * Возвращает content из text-блоков + usage (для трекинга стоимости в cron).
 *
 * Спринт 7.16.B, блок B1.5.
 */

import { getTextModelClient } from '@/lib/llm/text-client'
import { getBorisModel } from '@/lib/ai/models'
import { computeBorisCostUsd } from '@/lib/boris/metrics/cost'
import { getSelfAnalysisSystemPrompt } from './system-prompt'
import type { SelfAnalysisContext } from './context-builder'
import type Anthropic from '@anthropic-ai/sdk'

const MAX_TOKENS = 1500

export interface GenerateSelfAnalysisResult {
  content: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  model: string
  costUsd: number
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export async function generateSelfAnalysis(
  context: SelfAnalysisContext,
  model?: string
): Promise<GenerateSelfAnalysisResult> {
  const resolvedModel = model ?? getBorisModel()
  const client = getTextModelClient(resolvedModel)

  const userText =
    'Вот данные за неделю:\n\n```json\n' +
    JSON.stringify(context, null, 2) +
    '\n```\n\nНапиши отчёт по структуре, своим голосом.'

  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens: MAX_TOKENS,
    system: getSelfAnalysisSystemPrompt(),
    messages: [{ role: 'user', content: userText }],
  })

  const content = extractText(response.content)

  const inputTokens = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const cacheCreationInputTokens = response.usage.cache_creation_input_tokens ?? 0
  const cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0
  return {
    content,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    model: resolvedModel,
    costUsd: computeBorisCostUsd(inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens, resolvedModel),
  }
}
