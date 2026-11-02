import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { getInboxProvider } from '@/lib/ai/models'
import { getAnthropicClient } from './client'

// Только single-shot текст и классификация. Multi-turn агенты и Vision
// используют собственный Anthropic-клиент.
interface InboxParams {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: 'user'; content: string }>
  tools?: Anthropic.Messages.Tool[]
  tool_choice?: { type: 'tool'; name: string }
}

interface InboxMessage {
  content: Array<Anthropic.Messages.TextBlock | Anthropic.Messages.ToolUseBlock>
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null
  usage: { input_tokens: number; output_tokens: number }
}

interface InboxClient {
  messages: { create(params: InboxParams): Promise<InboxMessage> }
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
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
})

async function createOpenAIMessage(params: InboxParams): Promise<InboxMessage> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

  const body = JSON.stringify({
    model: params.model,
    instructions: params.system,
    input: params.messages,
    max_output_tokens: params.max_tokens,
    reasoning: { effort: 'none' },
    store: false,
    ...(params.tools?.length ? {
      tools: params.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        // Существующие схемы допускают необязательные поля. Валидация
        // результата остаётся в бизнес-функциях после вызова.
        strict: false,
      })),
      parallel_tool_calls: false,
    } : {}),
    ...(params.tool_choice ? {
      tool_choice: { type: 'function', name: params.tool_choice.name },
    } : {}),
  })

  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    if (response.ok) break
    // Не включаем тело ошибки: оно может содержать текст клиента или ключ.
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    throw new Error(`OpenAI API request failed (HTTP ${response.status})`)
  }

  const result = responseSchema.parse(await response.json())
  if (result.status === 'incomplete' && result.incomplete_details?.reason === 'max_output_tokens') {
    // Частичный tool-call нельзя превращать в изменение заказа.
    return { content: [], stop_reason: 'max_tokens', usage: result.usage }
  }
  if (result.status !== 'completed') throw new Error('OpenAI response was not completed')

  const content: InboxMessage['content'] = []
  for (const item of result.output) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'refusal') throw new Error('OpenAI refused the inbox request')
        if (block.type === 'output_text' && block.text) {
          content.push({ type: 'text', text: block.text, citations: null })
        }
      }
    } else if (item.type === 'function_call') {
      if (!item.name || !item.call_id || !item.arguments) {
        throw new Error('OpenAI returned an invalid function call')
      }
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: JSON.parse(item.arguments),
        caller: { type: 'direct' },
      })
    }
  }
  if (!content.length) throw new Error('OpenAI returned no inbox content')
  return {
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: result.usage,
  }
}

const openAIClient: InboxClient = { messages: { create: createOpenAIMessage } }

/** Сохраняет текущий контракт парсеров, переводя Responses в text/tool_use. */
export function getInboxClient(): InboxClient {
  if (getInboxProvider() === 'openai') return openAIClient
  const client = getAnthropicClient()
  return {
    messages: {
      async create(params) {
        const response = await client.messages.create(params)
        return {
          content: response.content.filter(
            (block): block is Anthropic.Messages.TextBlock | Anthropic.Messages.ToolUseBlock =>
              block.type === 'text' || block.type === 'tool_use',
          ),
          stop_reason: response.stop_reason === 'max_tokens' ? 'max_tokens'
            : response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
          usage: response.usage,
        }
      },
    },
  }
}
