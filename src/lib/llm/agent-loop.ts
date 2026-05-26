import Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from './client'

/**
 * Generic multi-turn tool_use loop для Anthropic SDK.
 *
 * Основа для AI-агента «Action-Борис» (Sprint 7.16.A.1, блок A1).
 * Волна A.2 будет регистрировать сюда tools поверх этого скелета.
 *
 * Отличие от single-shot tool_use (см. invoice-recognizer.ts): тут модель
 * может вызывать tool несколько раз подряд (поиск заказа → правка → отправка),
 * накапливая контекст в messages, пока не вернёт end_turn или не упрётся
 * в maxIterations / max_tokens / stop_sequence.
 *
 * Каждый tool — это объект с input_schema (JSON Schema, как в SDK) + execute().
 * Execute получает unknown — тулы сами валидируют свой input (через zod
 * или ручной cast). Так агент-loop не зависит от конкретных тулов.
 *
 * Fail-safe: исключение из tool.execute() не валит весь loop — оно
 * сериализуется в tool_result { is_error: true, content: <message> },
 * и модель получает возможность отреагировать (например, попробовать
 * другой tool или сообщить пользователю об ошибке).
 */

export interface AgentTool {
  name: string
  description: string
  input_schema: Anthropic.Messages.Tool.InputSchema
  execute: (input: unknown) => Promise<unknown> // возвращает что угодно сериализуемое в JSON
}

export interface AgentLoopOptions {
  model: string
  systemPrompt: string
  initialMessages: Anthropic.Messages.MessageParam[]
  tools: AgentTool[]
  maxIterations?: number // default 6
  maxTokens?: number // default 2048
  onToolCall?: (toolName: string, input: unknown) => void
  onToolResult?: (toolName: string, result: unknown) => void
}

export interface AgentLoopResult {
  finalText: string
  messages: Anthropic.Messages.MessageParam[]
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>
  iterations: number
  stopReason: string
}

function toAnthropicTool(tool: AgentTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function extractTextFromMessages(messages: Anthropic.Messages.MessageParam[]): string {
  // Тянем текст из последнего assistant-сообщения — для max_iterations / max_tokens
  // ситуаций, когда модель что-то успела сказать, но не дошла до end_turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    if (typeof msg.content === 'string') {
      return msg.content
    }
    const text = msg.content
      .filter(
        (b): b is Anthropic.Messages.TextBlockParam | Anthropic.Messages.TextBlock =>
          b.type === 'text'
      )
      .map((b) => b.text)
      .join('\n')
    if (text) return text
  }
  return ''
}

function truncateForLog(value: unknown, max = 200): string {
  let s: string
  try {
    s = JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    model,
    systemPrompt,
    initialMessages,
    tools,
    maxIterations = 6,
    maxTokens = 2048,
    onToolCall,
    onToolResult,
  } = opts

  const client = getAnthropicClient()
  const messages: Anthropic.Messages.MessageParam[] = [...initialMessages]
  const toolCalls: Array<{ name: string; input: unknown; result: unknown }> = []
  const anthropicTools = tools.map(toAnthropicTool)
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  let iterations = 0

  console.log(
    `[agent-loop] iter=0 start model=${model} tools=${tools.length} maxIterations=${maxIterations}`
  )

  while (iterations < maxIterations) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    })
    iterations++

    // Assistant-message в истории должен содержать оригинальные content-блоки
    // (включая tool_use), иначе следующий запрос упадёт на mismatch tool_use_id.
    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      const finalText = extractText(response.content)
      console.log(`[agent-loop] iter=${iterations} end_turn textLen=${finalText.length}`)
      return {
        finalText,
        messages,
        toolCalls,
        iterations,
        stopReason: 'end_turn',
      }
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
      )

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

      for (const block of toolUseBlocks) {
        const tool = toolsByName.get(block.name)
        console.log(
          `[agent-loop] iter=${iterations} tool_use name=${block.name} input=${truncateForLog(block.input)}`
        )

        if (!tool) {
          const errMsg = `Tool not found: ${block.name}`
          console.warn(`[agent-loop] iter=${iterations} tool_not_found name=${block.name}`)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: errMsg,
            is_error: true,
          })
          toolCalls.push({ name: block.name, input: block.input, result: { error: errMsg } })
          continue
        }

        onToolCall?.(block.name, block.input)

        try {
          const result = await tool.execute(block.input)
          onToolResult?.(block.name, result)
          toolCalls.push({ name: block.name, input: block.input, result })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
            is_error: false,
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(
            `[agent-loop] iter=${iterations} tool_error name=${block.name} err=${errMsg}`
          )
          toolCalls.push({ name: block.name, input: block.input, result: { error: errMsg } })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: errMsg,
            is_error: true,
          })
        }
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // max_tokens / stop_sequence / pause_turn / refusal — выходим, отдаём что есть.
    const finalText = extractText(response.content)
    const stopReason = response.stop_reason ?? 'unknown'
    console.log(
      `[agent-loop] iter=${iterations} stop_reason=${stopReason} textLen=${finalText.length}`
    )
    return {
      finalText,
      messages,
      toolCalls,
      iterations,
      stopReason,
    }
  }

  // Превысили maxIterations — пытаемся достать текст из последнего assistant message.
  const tailText = extractTextFromMessages(messages)
  const finalText = tailText || '⚠️ Превышен лимит шагов'
  console.warn(
    `[agent-loop] iter=${iterations} max_iterations reached toolCalls=${toolCalls.length}`
  )
  return {
    finalText,
    messages,
    toolCalls,
    iterations,
    stopReason: 'max_iterations',
  }
}
