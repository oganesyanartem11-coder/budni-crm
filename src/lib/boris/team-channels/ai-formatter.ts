/**
 * AI-formatter для Командного Бориса (Спринт 7.16.C, ЭТАП 1).
 *
 * Универсальный single-shot вызов модели для всех 4 каналов. Принимает
 * собранный контекст, возвращает либо готовый пост, либо решение «молчать».
 *
 * Архитектура:
 *   - НЕ multi-turn (нет tool_use) → single-shot client.messages.create.
 *   - System prompt стабильный per channel → cache_control:ephemeral.
 *   - User-message инлайнит JSON-контекст (он меняется per запуск).
 *   - Модель возвращает СТРОГО JSON {"action":"SEND"|"SILENT","text":"..."}.
 *   - Парсинг устойчив: stripped fences, fallback на SILENT при ошибке.
 *
 * Применение — этап 2-3 (cron-роуты каналов и UI-триггеры). Сейчас не зовётся
 * ниоткуда; этот файл подключают только тесты и будущие cron-роуты.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { Decimal } from '@prisma/client/runtime/library'
import { getAnthropicClient } from '@/lib/llm/client'
import { getBorisModel } from '@/lib/ai/models'
import { getTeamBorisSystemPrompt } from './personality'
import type { DayContext, EventContext, TeamChannel, TeamPostResult, WeekContext } from './types'

const MAX_TOKENS = 1200

// Тариф Sonnet 4.6 — синхронизируй с src/lib/boris/metrics/track.ts при смене модели.
const PRICE_INPUT_USD_PER_M = 3
const PRICE_OUTPUT_USD_PER_M = 15
const PRICE_CACHE_WRITE_USD_PER_M = PRICE_INPUT_USD_PER_M * 1.25
const PRICE_CACHE_READ_USD_PER_M = PRICE_INPUT_USD_PER_M * 0.1

function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
): number {
  const cost =
    (inputTokens * PRICE_INPUT_USD_PER_M +
      outputTokens * PRICE_OUTPUT_USD_PER_M +
      cacheCreationInputTokens * PRICE_CACHE_WRITE_USD_PER_M +
      cacheReadInputTokens * PRICE_CACHE_READ_USD_PER_M) /
    1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

interface LLMDecision {
  action: 'SEND' | 'SILENT'
  text: string
}

// Иногда модель оборачивает ответ в ```json ... ``` несмотря на инструкцию.
// Снимаем fences и parse'им. Падаем мягко — fallback на SILENT.
function parseDecision(raw: string): { ok: true; value: LLMDecision } | { ok: false; reason: string } {
  let stripped = raw.trim()
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    return { ok: false, reason: `json_parse_failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'not_object' }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.action !== 'SEND' && obj.action !== 'SILENT') {
    return { ok: false, reason: `bad_action: ${String(obj.action)}` }
  }
  if (typeof obj.text !== 'string') {
    return { ok: false, reason: 'text_not_string' }
  }
  return { ok: true, value: { action: obj.action, text: obj.text } }
}

// JSON-сериализация контекста с фильтром BigInt/Decimal — Prisma.Decimal не
// сериализуется в JSON.stringify по умолчанию. Решение через replacer: всё что
// «не объект и не нативный тип» приводим к строке.
function jsonifyForLLM(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (v && typeof v === 'object' && 'toFixed' in v && typeof (v as Decimal).toFixed === 'function') {
        return Number((v as Decimal).toString())
      }
      if (typeof v === 'bigint') return Number(v)
      return v
    },
    2,
  )
}

function buildUserMessage(channel: TeamChannel, context: DayContext | WeekContext | EventContext): string {
  const header =
    channel === 'LIVE'
      ? 'Контекст одного события для LIVE-канала:'
      : channel === 'EVENING'
        ? 'Контекст МСК-дня для EVENING-канала (итог в 20:00):'
        : channel === 'FRIDAY'
          ? 'Контекст финансовой недели Сб-Пт для FRIDAY-канала:'
          : 'Контекст для ALERT-канала — нужно действие сейчас:'

  return (
    `${header}\n\n` +
    '```json\n' +
    jsonifyForLLM(context) +
    '\n```\n\n' +
    'Действуй по правилам своего канала из системного промпта. Верни строго JSON.'
  )
}

/**
 * Главный вход модуля — превращает контекст в готовый пост (или решение молчать).
 *
 * Возвращает TeamPostResult с metrics, который вызывающий cron-роут потом
 * запишет в BorisBriefing + BorisMetrics. Никаких побочных эффектов в БД здесь
 * нет — это чистый LLM-вызов.
 */
export async function formatTeamPost(
  channel: TeamChannel,
  context: DayContext | WeekContext | EventContext,
  modelOverride?: string,
): Promise<TeamPostResult> {
  const client = getAnthropicClient()
  const model = modelOverride ?? getBorisModel()
  const systemPrompt = getTeamBorisSystemPrompt(channel, context)
  const userMessage = buildUserMessage(channel, context)

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    // System как array с cache_control: повторяющийся per-channel префикс
    // экономит до 90% input-токенов на втором+ запуске того же канала
    // в течение 5-мин ephemeral TTL.
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  })

  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const cacheCreationInputTokens = response.usage?.cache_creation_input_tokens ?? 0
  const cacheReadInputTokens = response.usage?.cache_read_input_tokens ?? 0
  const costUsd = computeCostUsd(inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens)

  const metrics = {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    costUsd,
  }

  const rawText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()

  const decoded = parseDecision(rawText)
  if (!decoded.ok) {
    console.error(`[team-boris/ai-formatter] channel=${channel} parse failed: ${decoded.reason}; raw=${rawText.slice(0, 200)}`)
    return {
      shouldSend: false,
      text: null,
      briefingPayload: {
        channel,
        parseError: decoded.reason,
        rawTextPreview: rawText.slice(0, 500),
      },
      metrics,
    }
  }

  const { action, text } = decoded.value
  if (action === 'SILENT') {
    return {
      shouldSend: false,
      text: null,
      briefingPayload: { channel, decision: 'SILENT' },
      metrics,
    }
  }

  return {
    shouldSend: true,
    text,
    briefingPayload: { channel, decision: 'SEND', textLength: text.length },
    metrics,
  }
}
