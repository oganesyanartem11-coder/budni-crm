/**
 * trackBorisCall — единая точка записи метрик LLM-вызовов Action-Бориса
 * и его cron-генераторов (morning/self-analysis).
 *
 * Принципы:
 * - НИКОГДА не throws — это инфраструктурная функция, ошибка трекинга НЕ должна
 *   ронять основной flow (чат с Борисом, executor, cron). Только console.error.
 * - costUsd считается по выбранной модели и отдельным счётчикам кеша.
 * - Decimal(10,6) → достаточно 6 знаков после запятой; round чтобы избежать
 *   проблем с float-сериализацией.
 *
 * Спринт 7.16.B, блок B1.2.
 */

import { prisma } from '@/lib/db/prisma'
import type { BorisMetricSource } from '@prisma/client'
import { computeBorisCostUsd } from './cost'

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
  model?: string
  source: BorisMetricSource
}

export async function trackBorisCall(input: TrackBorisCallInput): Promise<void> {
  try {
    const inputTokens = input.inputTokens ?? 0
    const outputTokens = input.outputTokens ?? 0
    const cacheCreationInputTokens = input.cacheCreationInputTokens ?? 0
    const cacheReadInputTokens = input.cacheReadInputTokens ?? 0
    const costUsd = computeBorisCostUsd(
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      input.model,
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
