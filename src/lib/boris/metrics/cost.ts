import { getBorisModel } from '@/lib/ai/models'

/** USD, стандартный тариф за 1M токенов. Счётчики кеша не входят в inputTokens. */
export function computeBorisCostUsd(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
  model = getBorisModel(),
): number {
  const luna = model === 'gpt-6-luna' || model.startsWith('gpt-6-luna-')
  const input = luna ? 0.1 : 3
  const output = luna ? 0.5 : 15
  const cost = (inputTokens * input + outputTokens * output
    + cacheCreationInputTokens * input * 1.25 + cacheReadInputTokens * input * 0.1) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}
