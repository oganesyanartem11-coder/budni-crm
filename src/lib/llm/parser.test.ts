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
