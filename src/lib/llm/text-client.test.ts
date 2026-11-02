import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { anthropicCreate } = vi.hoisted(() => ({ anthropicCreate: vi.fn() }))
vi.mock('./client', () => ({ getAnthropicClient: () => ({ messages: { create: anthropicCreate } }) }))

import { getBorisModel, getBorisProvider } from '@/lib/ai/models'
import { getTextModelClient } from './text-client'
import { runAgentLoop, type AgentTool } from './agent-loop'

const fetchMock = vi.fn()
const opts = {
  model: 'gpt-6-luna', systemPrompt: 'Борис: используй инструменты.',
  initialMessages: [{ role: 'user' as const, content: 'Сколько порций?' }],
  maxIterations: 4,
}
const schema = { type: 'object' as const, properties: { portions: { type: 'number' } }, required: ['portions'] }

function response(output: unknown[], cached = 0, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    status: 'completed', output,
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: cached } },
    ...extra,
  }))
}
const text = (value: string) => [{ type: 'message', content: [{ type: 'output_text', text: value }] }]
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OPENAI_API_KEY', 'test-key')
  vi.stubEnv('BORIS_AI_PROVIDER', '')
  vi.stubEnv('OPENAI_MODEL_BORIS', '')
  vi.stubEnv('ANTHROPIC_MODEL_BORIS', 'claude-sonnet-5')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('выбор модели Бориса', () => {
  it('выбирает Luna с ключом независимо от прежнего Anthropic override', () => {
    expect(getBorisProvider()).toBe('openai')
    expect(getBorisModel()).toBe('gpt-6-luna')
    vi.stubEnv('OPENAI_MODEL_BORIS', 'gpt-6-luna-snapshot')
    expect(getBorisModel()).toBe('gpt-6-luna-snapshot')
  })
  it('возвращает прежнюю модель без ключа и поддерживает явный rollback', () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(getBorisModel()).toBe('claude-sonnet-5')
    vi.stubEnv('OPENAI_API_KEY', 'key')
    vi.stubEnv('BORIS_AI_PROVIDER', 'anthropic')
    expect(getBorisProvider()).toBe('anthropic')
    expect(getBorisModel()).toBe('claude-sonnet-5')
  })
  it('ошибка конфигурации провайдера не игнорируется', () => {
    vi.stubEnv('BORIS_AI_PROVIDER', 'opneai')
    expect(() => getBorisModel()).toThrow('BORIS_AI_PROVIDER')
  })
})

describe('цикл Бориса через OpenAI Responses', () => {
  it('исполняет несколько инструментов, передаёт результаты и историю в следующий turn', async () => {
    const execute = vi.fn().mockResolvedValue({ portions: 30 })
    const fail = vi.fn().mockRejectedValue(new Error('Недостаточно прав'))
    const tools: AgentTool[] = [
      { name: 'find_orders', description: 'Поиск', input_schema: schema, execute },
      { name: 'restricted', description: 'Запрещённый', input_schema: schema, execute: fail },
    ]
    fetchMock.mockResolvedValueOnce(response([
      ...text('Проверяю.'), call('call_1', 'find_orders', { portions: 30 }), call('call_2', 'restricted', {}),
    ], 90)).mockResolvedValueOnce(response(text('30 порций. Изменение не выполнено.'), 20))

    const result = await runAgentLoop({ ...opts, tools })
    expect(result).toMatchObject({ finalText: '30 порций. Изменение не выполнено.', iterations: 2,
      stopReason: 'end_turn', inputTokens: 90, outputTokens: 40, cacheReadInputTokens: 110 })
    expect(execute).toHaveBeenCalledWith({ portions: 30 })
    expect(fail).toHaveBeenCalledOnce()
    const first = JSON.parse(fetchMock.mock.calls[0][1].body)
    const second = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(first.instructions).toBe(opts.systemPrompt)
    expect(first.tools[1]).not.toHaveProperty('cache_control')
    expect(first.parallel_tool_calls).toBe(true)
    expect(second.input).toEqual([
      { role: 'user', content: 'Сколько порций?' },
      { role: 'assistant', content: 'Проверяю.' },
      { type: 'function_call', call_id: 'call_1', name: 'find_orders', arguments: '{"portions":30}' },
      { type: 'function_call', call_id: 'call_2', name: 'restricted', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"portions":30}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"error":"Недостаточно прав"}' },
    ])
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(opts.initialMessages).toHaveLength(1)
  })

  it('сохраняет прошлые текстовые реплики пользователя и Бориса', async () => {
    fetchMock.mockResolvedValue(response(text('Да, речь о 30 порциях.')))
    await runAgentLoop({ ...opts, initialMessages: [
      { role: 'user', content: '30 порций' },
      { role: 'assistant', content: [{ type: 'text', text: 'Проверить на завтра?' }] },
      { role: 'user', content: 'Да' },
    ], tools: [] })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual([
      { role: 'user', content: '30 порций' }, { role: 'assistant', content: 'Проверить на завтра?' }, { role: 'user', content: 'Да' },
    ])
  })

  it('не исполняет tool_calls, если ответ оборван лимитом', async () => {
    const execute = vi.fn()
    fetchMock.mockResolvedValue(response([call('call_1', 'find_orders', {})], 0, {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }))
    const result = await runAgentLoop({ ...opts, tools: [{ name: 'find_orders', description: 'Поиск', input_schema: schema, execute }] })
    expect(result.stopReason).toBe('max_tokens')
    expect(execute).not.toHaveBeenCalled()
  })

  it('не исполняет даже первый инструмент, если второй вызов содержит битый JSON', async () => {
    const execute = vi.fn()
    fetchMock.mockResolvedValue(response([call('call_1', 'find_orders', {}), {
      type: 'function_call', call_id: 'call_2', name: 'find_orders', arguments: '{',
    }]))
    await expect(runAgentLoop({ ...opts, tools: [{ name: 'find_orders', description: '', input_schema: schema, execute }] })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('неизвестный инструмент возвращает модели ошибку и не исполняется', async () => {
    fetchMock.mockResolvedValueOnce(response([call('call_1', 'not_allowed', {})]))
      .mockResolvedValueOnce(response(text('Этот инструмент недоступен.')))
    const result = await runAgentLoop({ ...opts, tools: [] })
    expect(result.toolCalls[0].result).toEqual({ error: 'Tool not found: not_allowed' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).input.at(-1).output).toContain('Tool not found')
  })

  it('явный Claude override пользуется Anthropic, не OpenAI', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Старый провайдер' }],
      stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } })
    expect((await runAgentLoop({ ...opts, model: 'claude-sonnet-5', tools: [] })).finalText).toBe('Старый провайдер')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('не теряет неизвестные форматы истории молча', async () => {
    await expect(getTextModelClient('gpt-6-luna').messages.create({ model: 'gpt-6-luna', max_tokens: 300,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }],
    })).rejects.toThrow('Unsupported OpenAI text history block: image')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
