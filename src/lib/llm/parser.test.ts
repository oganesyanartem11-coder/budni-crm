import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('./client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}))
vi.mock('@/lib/ai/models', () => ({ getInboxModel: () => 'test-model' }))

import { parseClientResponse } from './parser'

const input = {
  clientText: 'на ужин 7',
  clientName: 'Тест Клиент',
  mealTypeRu: 'обеда или ужина',
  locations: [
    {
      id: 'loc_1',
      name: 'Офис',
      aliases: [],
      mealTypes: ['LUNCH', 'DINNER'] as const,
    },
  ],
  recentOrders: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseClientResponse mealType', () => {
  it('сохраняет конкретный валидный mealType из LLM item', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { output_tokens: 42 },
      content: [{
        type: 'text',
        text: JSON.stringify({
          type: 'numeric',
          items: [{
            locationId: 'loc_1',
            locationName: 'Офис',
            portions: 7,
            mealType: 'DINNER',
          }],
          confidence: 0.99,
          reason: 'Указан ужин',
          toneLabel: 'neutral',
        }),
      }],
    })

    const result = await parseClientResponse(input)

    expect(result.items).toEqual([{
      locationId: 'loc_1',
      locationName: 'Офис',
      portions: 7,
      mealType: 'DINNER',
    }])
    const request = mockCreate.mock.calls[0][0]
    expect(request.system).toContain('mealType')
    expect(request.messages[0].content).toContain('LUNCH, DINNER')
  })

  it('не пропускает неизвестный mealType в бизнес-логику', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { output_tokens: 42 },
      content: [{
        type: 'text',
        text: JSON.stringify({
          type: 'numeric',
          items: [{ locationId: 'loc_1', portions: 7, mealType: 'BRUNCH' }],
          confidence: 0.99,
          reason: 'invalid enum',
          toneLabel: 'neutral',
        }),
      }],
    })

    const result = await parseClientResponse(input)

    expect(result.items).toEqual([{ locationId: 'loc_1', locationName: '', portions: 7 }])
  })
})

describe('parseClientResponse — «добавьте / уберите» (mode=add, 07.10)', () => {
  function llm(items: unknown[]) {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { output_tokens: 42 },
      content: [{
        type: 'text',
        text: JSON.stringify({ type: 'numeric', items, confidence: 0.95, reason: '', toneLabel: 'neutral' }),
      }],
    })
  }

  it('в промпте есть правило про прибавку, mode=add и отрицательное изменение сохраняются', async () => {
    llm([
      { locationId: 'loc_1', locationName: 'Офис', portions: 2, mealType: 'LUNCH', mode: 'add' },
      { locationId: 'loc_1', locationName: 'Офис', portions: -3, mealType: 'DINNER', mode: 'add' },
    ])
    const result = await parseClientResponse({ ...input, clientText: 'обедов +2, ужинов на 3 меньше' })
    expect(mockCreate.mock.calls[0][0].system).toContain('ДОБАВИТЬ или УБРАТЬ')
    expect(result.items).toEqual([
      { locationId: 'loc_1', locationName: 'Офис', portions: 2, mealType: 'LUNCH', mode: 'add' },
      { locationId: 'loc_1', locationName: 'Офис', portions: -3, mealType: 'DINNER', mode: 'add' },
    ])
  })

  it('отрицательное число без mode=add и нулевое изменение отбрасываются', async () => {
    llm([
      { locationId: 'loc_1', locationName: 'Офис', portions: -3 },
      { locationId: 'loc_1', locationName: 'Офис', portions: 0, mode: 'add' },
    ])
    const result = await parseClientResponse(input)
    expect(result.items).toEqual([])
  })
})
