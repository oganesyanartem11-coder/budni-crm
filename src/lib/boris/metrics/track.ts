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

export interface TrackBorisCallInput {
  userId?: string
  conversationId?: string
  toolName?: string
  ok: boolean
  errorMessage?: string
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  source: BorisMetricSource
}

function computeCostUsd(inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens * PRICE_INPUT_USD_PER_M + outputTokens * PRICE_OUTPUT_USD_PER_M) / 1_000_000
  // Decimal(10,6) — 6 знаков после запятой.
  return Math.round(cost * 1_000_000) / 1_000_000
}

export async function trackBorisCall(input: TrackBorisCallInput): Promise<void> {
  try {
    const inputTokens = input.inputTokens ?? 0
    const outputTokens = input.outputTokens ?? 0
    const costUsd = computeCostUsd(inputTokens, outputTokens)

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
        costUsd,
        source: input.source,
      },
    })
  } catch (err) {
    // Никогда не throw — трекинг не должен ронять основной flow.
    console.error('[boris-metrics] failed to track', err)
  }
}
