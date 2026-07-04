/**
 * LLM-обвязка роли «трафик» (Борис-Директ): два яруса моделей + учёт стоимости.
 *
 * - heavy (Opus, env ANTHROPIC_MODEL_BORIS_DIRECT) — спорные минусы,
 *   недельный/месячный разбор, стратегия, текст владельцу;
 * - light (Haiku, env ANTHROPIC_MODEL_BORIS_DIRECT_LIGHT) — рутина.
 *
 * Opus НЕ гоняем на арифметике — все числа считает код до вызова.
 * Каждый вызов логируется в BorisDirectLlmLog (модель/токены/стоимость);
 * месячный потолок BORIS_DIRECT_LLM_MONTHLY_CAP_USD (дефолт 50 $): при
 * приближении неключевые heavy-вызовы деградируют на light, ведение
 * НЕ останавливается.
 */

import { getAnthropicClient } from '@/lib/llm/client'
import { callWithFallback } from '@/lib/ai/with-fallback'
import {
  getBorisDirectModel,
  getBorisDirectLightModel,
  getFallbackModel,
} from '@/lib/ai/models'
import { prisma } from '@/lib/db/prisma'
import { getLlmMonthlyCapUsd, LLM_CAP_WARN_RATIO } from './config'

export type LlmTier = 'heavy' | 'light'

// Тарифы USD за миллион токенов по семействам (при смене моделей — обновить).
// Cache-тиры Anthropic: write 1.25× input, read 0.10× input.
const PRICES: Array<{ match: RegExp; inputPerM: number; outputPerM: number }> = [
  { match: /opus/i, inputPerM: 15, outputPerM: 75 },
  { match: /sonnet/i, inputPerM: 3, outputPerM: 15 },
  { match: /haiku/i, inputPerM: 1, outputPerM: 5 },
]

export function computeLlmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0
): number {
  // Незнакомая модель → консервативно считаем по самому дорогому тарифу.
  const price = PRICES.find((p) => p.match.test(model)) ?? PRICES[0]
  const cost =
    (inputTokens * price.inputPerM +
      outputTokens * price.outputPerM +
      cacheCreationInputTokens * price.inputPerM * 1.25 +
      cacheReadInputTokens * price.inputPerM * 0.1) /
    1_000_000
  // Decimal(10,6) — 6 знаков после запятой.
  return Math.round(cost * 1_000_000) / 1_000_000
}

/** Потрачено на LLM роли за календарный месяц (МСК ~ UTC достаточно для потолка). */
export async function getMonthLlmSpendUsd(now: Date = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const agg = await prisma.borisDirectLlmLog.aggregate({
    where: { createdAt: { gte: monthStart } },
    _sum: { costUsd: true },
  })
  return Number(agg._sum.costUsd ?? 0)
}

export interface LlmBudgetStatus {
  spentUsd: number
  capUsd: number
  /** Потрачено ≥ LLM_CAP_WARN_RATIO потолка — предупредить владельца, рутину на light. */
  nearCap: boolean
}

export async function getLlmBudgetStatus(now: Date = new Date()): Promise<LlmBudgetStatus> {
  const spentUsd = await getMonthLlmSpendUsd(now)
  const capUsd = getLlmMonthlyCapUsd()
  return { spentUsd, capUsd, nearCap: spentUsd >= capUsd * LLM_CAP_WARN_RATIO }
}

export interface BorisDirectLlmCall {
  /** Назначение вызова — пишется в лог ('daily_report', 'minus_judgement', ...). */
  purpose: string
  tier: LlmTier
  system: string
  userText: string
  maxTokens?: number
  /**
   * Ключевой вызов (не деградировать на light при приближении к потолку).
   * Дефолт false: рутину при nearCap пересаживаем на light автоматически.
   */
  critical?: boolean
}

export interface BorisDirectLlmResult {
  text: string
  model: string
  costUsd: number
  /** true если heavy-вызов был деградирован на light из-за потолка. */
  downgraded: boolean
}

async function logCall(entry: {
  purpose: string
  model: string
  tier: LlmTier
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  ok: boolean
  errorMessage?: string
}): Promise<void> {
  try {
    await prisma.borisDirectLlmLog.create({ data: entry })
  } catch (err) {
    // Трекинг никогда не роняет основной flow.
    console.error('[boris-direct/llm] failed to log call', err)
  }
}

/**
 * Единственная точка вызова LLM для роли «трафик». Возвращает текст ответа.
 * Ошибки Anthropic пробрасываются (после логирования) — вызывающий крон сам
 * решает, что делать; heavy идёт через callWithFallback (5xx/529 → fallback).
 */
export async function callBorisDirectLlm(call: BorisDirectLlmCall): Promise<BorisDirectLlmResult> {
  let tier = call.tier
  let downgraded = false
  if (tier === 'heavy' && !call.critical) {
    const budget = await getLlmBudgetStatus()
    if (budget.nearCap) {
      tier = 'light'
      downgraded = true
      console.warn(
        `[boris-direct/llm] месячный LLM-бюджет близок к потолку (${budget.spentUsd.toFixed(2)}/${budget.capUsd} $) — '${call.purpose}' деградирован на light`
      )
    }
  }

  const model = tier === 'heavy' ? getBorisDirectModel() : getBorisDirectLightModel()
  const client = getAnthropicClient()
  const startedAt = Date.now()

  const doCall = async (m: string) =>
    client.messages.create({
      model: m,
      max_tokens: call.maxTokens ?? 2048,
      system: call.system,
      messages: [{ role: 'user', content: call.userText }],
    })

  try {
    // heavy — дорогой редкий вызов, страхуем fallback-моделью на 5xx/529.
    const response =
      tier === 'heavy'
        ? await callWithFallback(
            () => doCall(model),
            () => doCall(getFallbackModel()),
            `boris-direct:${call.purpose}`
          )
        : await doCall(model)

    const usedModel = response.model ?? model
    const inputTokens = response.usage?.input_tokens ?? 0
    const outputTokens = response.usage?.output_tokens ?? 0
    const costUsd = computeLlmCostUsd(usedModel, inputTokens, outputTokens)
    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

    await logCall({
      purpose: call.purpose,
      model: usedModel,
      tier,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs: Date.now() - startedAt,
      ok: true,
    })

    return { text, model: usedModel, costUsd, downgraded }
  } catch (err) {
    await logCall({
      purpose: call.purpose,
      model,
      tier,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** Сумма трат LLM за произвольный период — для строк в отчётах. */
export async function getLlmSpendForPeriod(from: Date, to: Date): Promise<{ costUsd: number; calls: number }> {
  const agg = await prisma.borisDirectLlmLog.aggregate({
    where: { createdAt: { gte: from, lt: to } },
    _sum: { costUsd: true },
    _count: { _all: true },
  })
  return { costUsd: Number(agg._sum.costUsd ?? 0), calls: agg._count._all }
}
