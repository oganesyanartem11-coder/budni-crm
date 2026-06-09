import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Boris reorg: classifyMessageRelatesToBoris зовёт глобальный Haiku
 * (getInboxModel) и парсит JSON {relates, confidence}. Мокаем Anthropic-клиент.
 *
 * Проверяем: (1) happy-path парсинг JSON; (2) fail-safe → {relates:false,
 * confidence:0} при брошенной ошибке; (3) fail-safe при битом JSON;
 * (4) НИКОГДА не бросает. Реального LLM не дёргаем.
 */

const mockCreate = vi.hoisted(() => vi.fn())
const mockHaikuLogCreate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/llm/client', () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}))
vi.mock('@/lib/ai/models', () => ({ getInboxModel: () => 'claude-test' }))
vi.mock('@/lib/db/prisma', () => ({
  prisma: { borisHaikuLog: { create: mockHaikuLogCreate } },
}))

import { classifyMessageRelatesToBoris } from './context-classifier'

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('classifyMessageRelatesToBoris — happy path', () => {
  it('парсит {relates:true, confidence:0.9}', async () => {
    mockCreate.mockResolvedValue(textResponse('{"relates": true, "confidence": 0.9}'))
    const r = await classifyMessageRelatesToBoris({
      text: 'спасибо, понял',
      lastBorisReply: 'Заказ на завтра — 30 порций.',
    })
    expect(r).toEqual({ relates: true, confidence: 0.9 })
  })

  it('парсит {relates:false, confidence:0.2}', async () => {
    mockCreate.mockResolvedValue(textResponse('{"relates": false, "confidence": 0.2}'))
    const r = await classifyMessageRelatesToBoris({ text: 'Серёг, ты обедал?' })
    expect(r).toEqual({ relates: false, confidence: 0.2 })
  })

  it('снимает ```json-обёртку', async () => {
    mockCreate.mockResolvedValue(
      textResponse('```json\n{"relates": true, "confidence": 0.7}\n```'),
    )
    const r = await classifyMessageRelatesToBoris({ text: 'а если на 5 больше?' })
    expect(r).toEqual({ relates: true, confidence: 0.7 })
  })

  it('confidence вне [0,1] → 0', async () => {
    mockCreate.mockResolvedValue(textResponse('{"relates": true, "confidence": 7}'))
    const r = await classifyMessageRelatesToBoris({ text: 'ага' })
    expect(r).toEqual({ relates: true, confidence: 0 })
  })

  it('при успешном вердикте пишет аудит в BorisHaikuLog с verdict из ответа', async () => {
    mockCreate.mockResolvedValue(textResponse('{"relates": true, "confidence": 0.8}'))
    await classifyMessageRelatesToBoris({
      text: 'спасибо, понял',
      lastBorisReply: 'Заказ на завтра — 30 порций.',
      chatId: 'chat-1',
    })
    expect(mockHaikuLogCreate).toHaveBeenCalled()
    expect(mockHaikuLogCreate.mock.calls[0][0]).toMatchObject({
      data: { verdict: true, chatId: 'chat-1' },
    })
  })

  it('логирует [haiku-cost] из usage', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    mockCreate.mockResolvedValue(textResponse('{"relates": false, "confidence": 0.1}'))
    await classifyMessageRelatesToBoris({ text: 'привет' })
    expect(spy).toHaveBeenCalledWith('[haiku-cost]', { inputTokens: 10, outputTokens: 5 })
    spy.mockRestore()
  })
})

describe('classifyMessageRelatesToBoris — fail-safe (молчим, не бросаем)', () => {
  it('брошенная ошибка API → {relates:false, confidence:0}', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'))
    const r = await classifyMessageRelatesToBoris({ text: 'что угодно' })
    expect(r).toEqual({ relates: false, confidence: 0 })
  })

  it('битый JSON → {relates:false, confidence:0}', async () => {
    mockCreate.mockResolvedValue(textResponse('это вообще не json'))
    const r = await classifyMessageRelatesToBoris({ text: 'что угодно' })
    expect(r).toEqual({ relates: false, confidence: 0 })
  })

  it('нет text-блока в ответе → fail-safe', async () => {
    mockCreate.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 0 } })
    const r = await classifyMessageRelatesToBoris({ text: 'что угодно' })
    expect(r).toEqual({ relates: false, confidence: 0 })
  })

  it('НИКОГДА не бросает (даже приброске)', async () => {
    mockCreate.mockRejectedValue(new Error('boom'))
    await expect(classifyMessageRelatesToBoris({ text: 'x' })).resolves.toBeDefined()
  })
})
