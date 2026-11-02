import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { getAnthropicClient } from './client'

export type TextModelParams = Pick<Anthropic.Messages.MessageCreateParamsNonStreaming,
  'model' | 'max_tokens' | 'system' | 'messages'> & {
  tools?: Anthropic.Messages.Tool[]
  tool_choice?: Anthropic.Messages.ToolChoice
}

export interface TextModelMessage {
  content: Anthropic.Messages.ContentBlock[]
  stop_reason: Anthropic.Messages.StopReason | null
  usage: Pick<Anthropic.Messages.Usage,
    'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>
}

export interface TextModelClient {
  messages: { create(params: TextModelParams): Promise<TextModelMessage> }
}

const responseSchema = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })),
  usage: z.object({
    input_tokens: z.number(), output_tokens: z.number(),
    input_tokens_details: z.object({
      cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional(),
    }).optional(),
  }),
})

type ResponseInput =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** Сохраняем порядок текста, вызовов и результатов в существующей истории CRM. */
function toResponseInput(messages: Anthropic.Messages.MessageParam[]): ResponseInput[] {
  const input: ResponseInput[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push({ role: message.role, content: message.content })
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        input.push({ role: message.role, content: block.text })
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) })
      } else if (block.type === 'tool_result' && message.role === 'user') {
        const result = block.content ?? ''
        const output = typeof result === 'string' ? result : result.map((part) => {
          if (part.type !== 'text') throw new Error('OpenAI text client requires text tool results')
          return part.text
        }).join('\n')
        input.push({
          type: 'function_call_output', call_id: block.tool_use_id,
          output: block.is_error ? JSON.stringify({ error: output }) : output,
        })
      } else {
        throw new Error(`Unsupported OpenAI text history block: ${block.type}`)
      }
    }
  }
  return input
}

async function createOpenAIMessage(params: TextModelParams): Promise<TextModelMessage> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  const instructions = typeof params.system === 'string' ? params.system
    : params.system?.map((block) => block.text).join('\n')
  const choice = params.tool_choice
  const toolChoice = choice?.type === 'tool' ? { type: 'function', name: choice.name }
    : choice?.type === 'any' ? 'required' : choice?.type
  const body = JSON.stringify({
    model: params.model,
    instructions,
    input: toResponseInput(params.messages),
    max_output_tokens: params.max_tokens,
    reasoning: { effort: 'none' },
    store: false,
    ...(params.tools?.length ? {
      tools: params.tools.map((tool) => ({
        type: 'function', name: tool.name, description: tool.description,
        parameters: tool.input_schema,
        // Поля действующих схем CRM могут быть необязательными.
        // Валидация входа и проверка прав выполняются самими инструментами.
        strict: false,
      })),
      parallel_tool_calls: choice?.type === 'tool' ? false : true,
    } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  })

  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body, cache: 'no-store', signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) break
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    // Тело ошибки может содержать исходный запрос или секрет — не логируем его.
    throw new Error(`OpenAI API request failed (HTTP ${response.status})`)
  }

  const result = responseSchema.parse(await response.json())
  const cacheRead = result.usage.input_tokens_details?.cached_tokens ?? 0
  const cacheWrite = result.usage.input_tokens_details?.cache_write_tokens ?? 0
  const usage = {
    // В Anthropic-формате эти три счётчика не пересекаются.
    input_tokens: Math.max(0, result.usage.input_tokens - cacheRead - cacheWrite),
    output_tokens: result.usage.output_tokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  }
  if (result.status === 'incomplete' && result.incomplete_details?.reason === 'max_output_tokens') {
    return { content: [], stop_reason: 'max_tokens', usage }
  }
  if (result.status !== 'completed') throw new Error('OpenAI response was not completed')

  const content: TextModelMessage['content'] = []
  for (const item of result.output) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'refusal') throw new Error('OpenAI refused the text request')
        if (block.type === 'output_text' && block.text) {
          content.push({ type: 'text', text: block.text, citations: null })
        }
      }
    } else if (item.type === 'function_call') {
      if (!item.name || !item.call_id || !item.arguments) throw new Error('OpenAI returned an invalid function call')
      content.push({
        type: 'tool_use', id: item.call_id, name: item.name,
        input: JSON.parse(item.arguments), caller: { type: 'direct' },
      })
    }
  }
  if (!content.length) throw new Error('OpenAI returned no text content')
  return {
    content, usage,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
  }
}

const openAIClient: TextModelClient = { messages: { create: createOpenAIMessage } }

export function getOpenAITextClient(): TextModelClient { return openAIClient }

/** Явные Claude-overrides продолжают работать с прежним провайдером. */
export function getTextModelClient(model: string): TextModelClient {
  if (!model.startsWith('claude-')) return openAIClient
  const client = getAnthropicClient()
  return { messages: { create: (params) => client.messages.create(params) } }
}
