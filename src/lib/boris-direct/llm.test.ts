import { describe, it, expect } from 'vitest'
import { computeLlmCostUsd } from './llm'

describe('computeLlmCostUsd — тарифы по семействам моделей', () => {
  it('opus: 15/75 $ за M', () => {
    // 1M input + 1M output = 15 + 75 = 90 $
    expect(computeLlmCostUsd('claude-opus-4-7', 1_000_000, 1_000_000)).toBe(90)
  })

  it('haiku: 1/5 $ за M', () => {
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBe(6)
  })

  it('sonnet: 3/15 $ за M', () => {
    expect(computeLlmCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(18)
  })

  it('незнакомая модель → консервативно самый дорогой тариф (opus)', () => {
    expect(computeLlmCostUsd('mystery-model', 1_000_000, 0)).toBe(15)
  })

  it('cache write 1.25× и cache read 0.10× от input-тарифа', () => {
    // haiku: 1M cache write = 1.25 $, 1M cache read = 0.1 $
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 0, 0, 1_000_000, 0)).toBe(1.25)
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 0, 0, 0, 1_000_000)).toBe(0.1)
  })

  it('округление до 6 знаков (Decimal(10,6))', () => {
    const cost = computeLlmCostUsd('claude-haiku-4-5-20251001', 123, 456)
    expect(cost).toBe(Math.round((123 * 1 + 456 * 5) / 1_000_000 * 1_000_000) / 1_000_000)
    expect(String(cost).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6)
  })
})
