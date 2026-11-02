import { getInboxProvider } from '@/lib/ai/models'
import { getAnthropicClient } from './client'
import { getOpenAITextClient, type TextModelClient } from './text-client'

/** Общий протокол text/tool_use для клиентских парсеров и OpenAI Responses. */
export function getInboxClient(): TextModelClient {
  if (getInboxProvider() === 'openai') return getOpenAITextClient()
  const client = getAnthropicClient()
  return { messages: { create: (params) => client.messages.create(params) } }
}
