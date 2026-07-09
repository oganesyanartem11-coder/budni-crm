/**
 * Smoke-тест типов для runAgentLoop. НЕ ЗАПУСКАТЬ автоматически —
 * скрипт нужен только для проверки, что TS-сигнатуры стыкуются.
 *
 * Запуск (если что): `npx tsx scripts/test-agent-loop.ts` (с ANTHROPIC_API_KEY).
 */
import { runAgentLoop, type AgentTool } from '@/lib/llm/agent-loop'

const echoTool: AgentTool = {
  name: 'echo',
  description: 'Echo the message back.',
  input_schema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
    },
    required: ['message'],
  },
  execute: async (input: unknown) => {
    const { message } = input as { message: string }
    return { echoed: message }
  },
}

async function main() {
  const result = await runAgentLoop({
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are a test agent. Use the echo tool then say goodbye.',
    initialMessages: [{ role: 'user', content: 'Echo "hello world" then say bye.' }],
    tools: [echoTool],
    maxIterations: 4,
    onToolCall: (name, input) => console.log('toolCall', name, input),
    onToolResult: (name, result) => console.log('toolResult', name, result),
  })
  console.log('finalText:', result.finalText)
  console.log('iterations:', result.iterations)
  console.log('stopReason:', result.stopReason)
  console.log('toolCalls:', result.toolCalls.length)
}

// NOTE: не вызываем, чтобы не палить токены и не требовать API key при tsc-проверке.
void main
