/**
 * trackBorisCall — единая точка записи метрик LLM-вызовов Action-Бориса
 * и его cron-генераторов (morning/self-analysis).
 *
 * Принципы:
 * - НИКОГДА не throws — это инфраструктурная функция, ошибка трекинга НЕ должна
 *   ронять основной flow (чат с Борисом, executor, cron). Только console.error.
 * - costUsd считается прямо здесь по тарифу Sonnet 4.6 ($3/M input, $15/M output).
 *   Когда сменим модель — обновить в одном месте.
 * - Decimal(10,6) → достаточно 6 знаков после запятой; round чтобы избежать
 *   проблем с float-сериализацией.
 *
 * Спринт 7.16.B, блок B1.2.
 */

import { prisma } from '@/lib/db/prisma'
import type { BorisMetricSource } from '@prisma/client'

// Тариф Sonnet 4.6 (USD per million tokens). При смене модели — обновить тут.
const PRICE_INPUT_USD_PER_M = 3
const PRICE_OUTPUT_USD_PER_M = 15
// 7.16.D: prompt caching tier'ы Anthropic.
//  - cache write: 1.25× базового input
//  - cache read:  0.10× базового input
// На output caching не влияет — output_tokens оплачивается по обычной цене.
const PRICE_CACHE_WRITE_USD_PER_M = PRICE_INPUT_USD_PER_M * 1.25
const PRICE_CACHE_READ_USD_PER_M = PRICE_INPUT_USD_PER_M * 0.1

export interface TrackBorisCallInput {
  userId?: string
  conversationId?: string
  toolName?: string
  ok: boolean
  errorMessage?: string
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  /**
   * 7.16.D: токены, записанные в кеш на этом запросе (первый turn беседы
   * после изменения system/tools). Берётся из response.usage.cache_creation_input_tokens.
   */
  cacheCreationInputTokens?: number
  /**
   * 7.16.D: токены, прочитанные из кеша (последующие turn'ы беседы в течение
   * 5-мин ephemeral TTL). Берётся из response.usage.cache_read_input_tokens.
   */
  cacheReadInputTokens?: number
  source: BorisMetricSource
}

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
  // Decimal(10,6) — 6 знаков после запятой.
  return Math.round(cost * 1_000_000) / 1_000_000
}

export async function trackBorisCall(input: TrackBorisCallInput): Promise<void> {
  try {
    const inputTokens = input.inputTokens ?? 0
    const outputTokens = input.outputTokens ?? 0
    const cacheCreationInputTokens = input.cacheCreationInputTokens ?? 0
    const cacheReadInputTokens = input.cacheReadInputTokens ?? 0
    const costUsd = computeCostUsd(
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    )

    await prisma.borisMetrics.create({
      data: {
        userId: input.userId ?? null,
        conversationId: input.conversationId ?? null,
        toolName: input.toolName ?? null,
        ok: input.ok,
        errorMessage: input.errorMessage ?? null,
        durationMs: input.durationMs,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        costUsd,
        source: input.source,
      },
    })
  } catch (err) {
    // Никогда не throw — трекинг не должен ронять основной flow.
    console.error('[boris-metrics] failed to track', err)
  }
}
