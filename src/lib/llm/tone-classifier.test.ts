import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * MEGA-3 (П7): перекалибровка tone-классификатора.
 *
 * classifyMessageTone зовёт Anthropic (tool_use submit_tone). Мокаем клиента —
 * проверяем: (1) детерминированные shortcut'ы без LLM (CAPS → rude, короткое →
 * neutral); (2) парсинг tool_use в ToneLabel; (3) fail-safe → neutral;
 * (4) что в SYSTEM-промт зашиты новые правила/примеры (через инспекцию
 * аргумента вызова), чтобы «через пол часа» уходило в neutral, а «прямо
 * сейчас» — в urgent. Реального LLM не дёргаем.
 */

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}))
vi.mock('@/lib/ai/models', () => ({ getInboxModel: () => 'claude-test' }))

import { classifyMessageTone } from './tone-classifier'

function toolResponse(tone: string) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'submit_tone', input: { tone } }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('classifyMessageTone — shortcuts (без LLM)', () => {
  it('CAPS LOCK негатив → rude без вызова LLM', async () => {
    const tone = await classifyMessageTone('ВЫ ОПЯТЬ ВСЁ ИСПОРТИЛИ')
    expect(tone).toBe('rude')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('очень короткое сообщение → neutral без LLM', async () => {
    const tone = await classifyMessageTone('!')
    expect(tone).toBe('neutral')
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('classifyMessageTone — парсинг tool_use', () => {
  it('LLM вернул urgent → urgent', async () => {
    mockCreate.mockResolvedValue(toolResponse('urgent'))
    expect(await classifyMessageTone('Отмените заказ прямо сейчас!')).toBe('urgent')
  })

  it('LLM вернул neutral → neutral', async () => {
    mockCreate.mockResolvedValue(toolResponse('neutral'))
    expect(await classifyMessageTone('Можете подъехать через пол часа?')).toBe('neutral')
  })

  it('невалидный tone → neutral (fail-safe)', async () => {
    mockCreate.mockResolvedValue(toolResponse('panic'))
    expect(await classifyMessageTone('что-то непонятное')).toBe('neutral')
  })

  it('нет tool_use в ответе → neutral', async () => {
    mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] })
    expect(await classifyMessageTone('обычный текст')).toBe('neutral')
  })

  it('ошибка LLM → neutral (fail-safe)', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'))
    expect(await classifyMessageTone('обычный текст')).toBe('neutral')
  })
})

describe('classifyMessageTone — калибровка промта (П7)', () => {
  it('SYSTEM-промт содержит правила про «через пол часа» как НЕ urgent', async () => {
    mockCreate.mockResolvedValue(toolResponse('neutral'))
    await classifyMessageTone('Доставьте, пожалуйста, через пол часа')
    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toMatch(/через пол часа/i)
    expect(call.system).toMatch(/15 минут/i)
    // Маркеры явной срочности перечислены.
    expect(call.system).toMatch(/прямо сейчас/i)
    expect(call.system).toMatch(/немедленно/i)
  })

  it('SYSTEM-промт содержит few-shot примеры (positive и negative)', async () => {
    mockCreate.mockResolvedValue(toolResponse('urgent'))
    await classifyMessageTone('срочно перезвоните')
    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toMatch(/Примеры urgent/i)
    expect(call.system).toMatch(/НЕ urgent/i)
  })
})
