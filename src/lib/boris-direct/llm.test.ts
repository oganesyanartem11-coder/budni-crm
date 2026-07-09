import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreate, mockLogCreate, mockAggregate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockLogCreate: vi.fn(),
  mockAggregate: vi.fn(),
}))

vi.mock('@/lib/llm/client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectLlmLog: { create: mockLogCreate, aggregate: mockAggregate },
  },
}))
// Light-путь fallback не использует; пробрасываем primary на всякий случай.
vi.mock('@/lib/ai/with-fallback', () => ({
  callWithFallback: (primary: () => Promise<unknown>) => primary(),
}))

import { computeLlmCostUsd, callBorisDirectLlm } from './llm'

describe('computeLlmCostUsd — тарифы по семействам моделей', () => {
  it('opus: 5/25 $ за M (Opus 4.7 и 4.8 — одинаковая цена)', () => {
    // 1M input + 1M output = 5 + 25 = 30 $
    expect(computeLlmCostUsd('claude-opus-4-7', 1_000_000, 1_000_000)).toBe(30)
    expect(computeLlmCostUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(30)
  })

  it('haiku: 1/5 $ за M', () => {
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBe(6)
  })

  it('sonnet: 3/15 $ за M (матчится и sonnet-4-6 light, и fallback)', () => {
    expect(computeLlmCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(18)
  })

  it('матчинг тарифа по имени: /opus/i → opus-4-8, /sonnet/i → sonnet-4-6', () => {
    // input-only, чтобы читать чистый input-тариф семейства.
    expect(computeLlmCostUsd('claude-opus-4-8', 1_000_000, 0)).toBe(5)
    expect(computeLlmCostUsd('claude-sonnet-4-6', 1_000_000, 0)).toBe(3)
  })

  it('незнакомая модель → консервативно самый дорогой тариф (opus 5)', () => {
    expect(computeLlmCostUsd('mystery-model', 1_000_000, 0)).toBe(5)
  })

  it('cache write 1.25× и cache read 0.10× от input-тарифа', () => {
    // haiku: 1M cache write = 1.25 $, 1M cache read = 0.1 $
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 0, 0, 1_000_000, 0)).toBe(1.25)
    expect(computeLlmCostUsd('claude-haiku-4-5-20251001', 0, 0, 0, 1_000_000)).toBe(0.1)
  })

  it('cache-множители от НОВОГО opus-тарифа (5): write 1M = 6.25, read 1M = 0.5', () => {
    expect(computeLlmCostUsd('claude-opus-4-8', 0, 0, 1_000_000, 0)).toBe(6.25)
    expect(computeLlmCostUsd('claude-opus-4-8', 0, 0, 0, 1_000_000)).toBe(0.5)
  })

  it('округление до 6 знаков (Decimal(10,6))', () => {
    const cost = computeLlmCostUsd('claude-haiku-4-5-20251001', 123, 456)
    expect(cost).toBe(Math.round((123 * 1 + 456 * 5) / 1_000_000 * 1_000_000) / 1_000_000)
    expect(String(cost).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6)
  })
})

describe('callBorisDirectLlm — кеш-токены из usage прокинуты в стоимость', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLogCreate.mockResolvedValue({})
    mockAggregate.mockResolvedValue({ _sum: { costUsd: 0 } })
  })

  it('light-вызов sonnet: costUsd учитывает cache_creation/cache_read из usage', async () => {
    mockCreate.mockResolvedValue({
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 4000,
      },
      content: [{ type: 'text', text: 'ok' }],
    })

    const res = await callBorisDirectLlm({ purpose: 'test', tier: 'light', system: 's', userText: 'u' })

    // sonnet 3/15: 1000×3 + 500×15 + 2000×3×1.25 + 4000×3×0.1 = 3000+7500+7500+1200 = 19200 /1e6
    expect(res.costUsd).toBeCloseTo(0.0192, 9)
    // Та же стоимость записана в лог (учёт кеша сквозной).
    expect(mockLogCreate).toHaveBeenCalledTimes(1)
    expect(mockLogCreate.mock.calls[0][0].data.costUsd).toBeCloseTo(0.0192, 9)
  })

  it('usage без кеш-полей → стоимость как без кеша (поведение не меняется)', async () => {
    mockCreate.mockResolvedValue({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: 'text', text: 'ok' }],
    })

    const res = await callBorisDirectLlm({ purpose: 'test', tier: 'light', system: 's', userText: 'u' })

    // Без кеша: 1000×3 + 500×15 = 10500 /1e6 = 0.0105
    expect(res.costUsd).toBeCloseTo(0.0105, 9)
  })
})
