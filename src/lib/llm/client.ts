import Anthropic from '@anthropic-ai/sdk'

export const LLM_MODEL = 'claude-haiku-4-5-20251001'

let anthropicInstance: Anthropic | null = null

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set')
  }
  if (!anthropicInstance) {
    anthropicInstance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return anthropicInstance
}
