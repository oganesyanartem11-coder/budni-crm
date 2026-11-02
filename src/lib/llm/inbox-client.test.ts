import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }))
vi.mock('./client', () => ({
  getAnthropicClient: () => ({ messages: { create: anthropicCreate } }),
}))

import { getInboxClient } from './inbox-client'
import { getInboxModel, getInboxProvider } from '@/lib/ai/models'
import { parseChangeIntent } from '@/lib/bot/parse-change-intent'
import { parseClientResponse } from './parser'
import { classifyMessageTone } from './tone-classifier'
import { generateDraftReply } from './draft-generator'

const fetchMock = vi.fn()
const params = {
  model: 'gpt-6-luna', max_tokens: 300, system: 'Верни JSON.',
  messages: [{ role: 'user' as const, content: 'На завтра 30 обедов' }],
}

function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20 }, ...extra,
  }))
}

function text(value: string) {
  return [{ type: 'message', content: [{ type: 'output_text', text: value }] }]
}

function tool(name: string, input: unknown) {
  return [{ type: 'function_call', call_id: 'call_1', name, arguments: JSON.stringify(input) }]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-secret')
  vi.stubEnv('INBOX_AI_PROVIDER', '')
  vi.stubEnv('OPENAI_MODEL_INBOX', '')
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('inbox provider', () => {
  it('включает Luna при наличии ключа, допускает override модели', () => {
    expect(getInboxProvider()).toBe('openai')
    expect(getInboxModel()).toBe('gpt-6-luna')
    vi.stubEnv('OPENAI_MODEL_INBOX', 'custom-model')
    expect(getInboxModel()).toBe('custom-model')
  })

  it('сохраняет Haiku без ключа OpenAI и при явном rollback', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_MODEL_INBOX', 'claude-custom')
    expect(getInboxProvider()).toBe('anthropic')
    expect(getInboxModel()).toBe('claude-custom')
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('INBOX_AI_PROVIDER', 'anthropic')
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], usage: {}, stop_reason: 'end_turn' })
    await getInboxClient().messages.create({ ...params, model: getInboxModel() })
    expect(anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-custom' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('явный OpenAI без ключа не отправляет запрос и не переключается на Haiku', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('INBOX_AI_PROVIDER', 'openai')
    await expect(getInboxClient().messages.create(params)).rejects.toThrow('OPENAI_API_KEY is not set')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('ошибка в имени провайдера не переключает обработку молча', () => {
    vi.stubEnv('INBOX_AI_PROVIDER', 'opneai')
    expect(() => getInboxProvider()).toThrow('INBOX_AI_PROVIDER')
  })
})

describe('OpenAI Responses adapter', () => {
  it('посылает инструкции, модель, лимит и возвращает текст с usage', async () => {
    fetchMock.mockResolvedValue(response(text('{"relates":true}')))
    const result = await getInboxClient().messages.create(params)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(init.headers.Authorization).toBe('Bearer test-openai-secret')
    expect(init.cache).toBe('no-store')
    expect(JSON.parse(init.body)).toEqual({
      model: 'gpt-6-luna', instructions: params.system, input: params.messages,
      max_output_tokens: 300, reasoning: { effort: 'none' }, store: false,
    })
    expect(result.content).toEqual([{ type: 'text', text: '{"relates":true}', citations: null }])
    expect(result.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 })
  })

  it('преобразует принудительный tool_choice и tool_use', async () => {
    fetchMock.mockResolvedValue(response(tool('submit_tone', { tone: 'urgent' })))
    expect(await classifyMessageTone('Нужна замена прямо сейчас')).toBe('urgent')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tool_choice).toEqual({ type: 'function', name: 'submit_tone' })
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.tools[0]).toMatchObject({
      type: 'function', name: 'submit_tone', strict: false,
      parameters: { required: ['tone'] },
    })
  })

  it('передаёт изменение количества и дату до бизнес-парсера', async () => {
    fetchMock.mockResolvedValue(response(tool('submit_change_intent', {
      action: 'CHANGE', portions: -2, mode: 'add', date: '2026-11-03', dateTo: null,
      mealType: 'ОБЕД', confidence: 0.99, reason: 'Убрать две порции',
    })))
    const result = await parseChangeIntent('На завтра на 2 обеда меньше', {
      clientName: 'Тест', today: new Date('2026-11-02T09:00:00Z'), availableMealTypes: ['ОБЕД'],
    })
    expect(result).toMatchObject({ action: 'CHANGE', portions: -2, mode: 'add', date: '2026-11-03' })
  })

  it('сохраняет количества, тип еды и отрицательное изменение в разборе заказа', async () => {
    fetchMock.mockResolvedValue(response(text(JSON.stringify({
      type: 'numeric', items: [{ locationId: 'office', locationName: 'Офис', portions: -3, mode: 'add', mealType: 'LUNCH' }],
      confidence: 0.99, reason: 'Убрать три обеда', toneLabel: 'neutral',
    }))))
    const result = await parseClientResponse({
      clientName: 'Тест', clientText: 'Обедов на 3 меньше', mealTypeRu: 'обеда',
      locations: [{ id: 'office', name: 'Офис', aliases: [] }], recentOrders: [],
    })
    expect(result.items).toEqual([{ locationId: 'office', locationName: 'Офис', portions: -3, mode: 'add', mealType: 'LUNCH' }])
  })

  it('возвращает черновик ответа', async () => {
    fetchMock.mockResolvedValue(response(text('  Уточним время доставки и сообщим.  ')))
    expect(await generateDraftReply({ clientName: 'Тест', clientMessages: [] }))
      .toBe('Уточним время доставки и сообщим.')
  })

  it('повторяет HTTP 429/5xx один раз', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(response(text('ok')))
    await getInboxClient().messages.create(params)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('не повторяет 401 и не раскрывает тело ошибки', async () => {
    fetchMock.mockResolvedValue(new Response('test-openai-secret private-client-text', { status: 401 }))
    await expect(getInboxClient().messages.create(params))
      .rejects.toThrow(/^OpenAI API request failed \(HTTP 401\)$/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('не принимает частичный tool-call при исчерпании лимита', async () => {
    fetchMock.mockResolvedValue(response(tool('submit_tone', { tone: 'rude' }), {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }))
    const result = await getInboxClient().messages.create(params)
    expect(result).toMatchObject({ content: [], stop_reason: 'max_tokens' })
  })

  it.each([
    { status: 'failed' },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    { output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
    { output: [{ type: 'function_call', call_id: 'call_1', name: 'submit_tone', arguments: '{' }] },
    { output: [] },
  ])('отклоняет незавершённый, отказной или невалидный ответ: %j', async (extra) => {
    fetchMock.mockResolvedValue(response(text('ok'), extra))
    await expect(getInboxClient().messages.create(params)).rejects.toThrow()
  })
})
