/**
 * AI-агент Action-Борис: главная функция chatWithBoris (Спринт 7.16.A.2, блок B2).
 *
 * Что делает:
 * 1. Находит или создаёт открытый BorisConversation для userId
 * 2. Загружает последние 20 BorisMessage как контекст
 * 3. Добавляет новый user-message в БД
 * 4. Запускает agent-loop с BORIS_TOOLS
 * 5. Если LLM вернул pending-actions через mutate-tools — собирает их в
 *    BorisPendingAction (TTL 5 мин) и возвращает preview для inline-кнопки
 * 6. Сохраняет assistant-ответ в БД
 *
 * Контекст модели: history (как Anthropic MessageParam) + новый user-text.
 * Tool-результаты НЕ персистятся в BorisMessage — они дорогие и больше не
 * понадобятся (модель уже их обработала и выдала финальный текст).
 * Если хотим debug — можно достать из ActivityLog.
 */

import { runAgentLoop } from '@/lib/llm/agent-loop'
import { getBorisModel } from '@/lib/ai/models'
import { getBorisSystemPrompt } from './personality'
import { BORIS_TOOLS } from './tools'
import { buildMultiActionPreview, type PendingActionForPreview } from './preview'
import { trackBorisCall } from './metrics/track'
import { prisma } from '@/lib/db/prisma'
import { BorisMetricSource, type Prisma } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000
const HISTORY_LIMIT = 20

export interface ChatWithBorisInput {
  userId: string
  conversationId?: string
  userText: string
}

export interface ChatWithBorisResult {
  conversationId: string
  reply: string
  pendingActionId?: string
  preview?: string
}

export async function chatWithBoris(input: ChatWithBorisInput): Promise<ChatWithBorisResult> {
  // 1. Найти или создать открытую беседу.
  let conversation = input.conversationId
    ? await prisma.borisConversation.findFirst({
        where: { id: input.conversationId, userId: input.userId, closedAt: null },
      })
    : await prisma.borisConversation.findFirst({
        where: { userId: input.userId, closedAt: null },
        orderBy: { lastMessageAt: 'desc' },
      })

  if (!conversation) {
    conversation = await prisma.borisConversation.create({
      data: { userId: input.userId },
    })
  }

  // 2. Загрузить последние HISTORY_LIMIT сообщений (asc по createdAt для модели).
  const history = await prisma.borisMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  })
  history.reverse()

  const historyMessages: Anthropic.Messages.MessageParam[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      // content уже сохранён в Anthropic-формате (string или ContentBlock[]).
      content: m.content as Anthropic.Messages.MessageParam['content'],
    }))

  const userMessage: Anthropic.Messages.MessageParam = {
    role: 'user',
    content: input.userText,
  }

  // 3. Сохранить user-message ДО loop, чтобы при падении мы хотя бы видели запрос.
  await prisma.borisMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: input.userText,
    },
  })

  // 4. Запуск agent-loop. Оборачиваем в try/catch для metrics-трекинга —
  // на исключении пишем fail-метрику и пробрасываем дальше (выше по стеку
  // ловят telegram/boris-handler или web-route).
  const startedAt = Date.now()
  let result
  try {
    result = await runAgentLoop({
      model: getBorisModel(),
      systemPrompt: getBorisSystemPrompt(),
      initialMessages: [...historyMessages, userMessage],
      tools: BORIS_TOOLS,
      maxIterations: 8,
      maxTokens: 2048,
      onToolCall: (name) => {
        console.log('[boris] tool_use', name)
      },
    })
  } catch (err) {
    await trackBorisCall({
      userId: input.userId,
      conversationId: conversation.id,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      source: BorisMetricSource.ACTION_CHAT,
    })
    throw err
  }

  await trackBorisCall({
    userId: input.userId,
    conversationId: conversation.id,
    ok: true,
    durationMs: Date.now() - startedAt,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    source: BorisMetricSource.ACTION_CHAT,
  })

  // 5. Собрать pending-actions из tool-результатов.
  const pendingActions: PendingActionForPreview[] = []
  for (const call of result.toolCalls) {
    const r = call.result as { pending?: boolean; action?: { tool: string; input: Record<string, unknown> }; preview?: string } | null
    if (r && r.pending === true && r.action) {
      pendingActions.push({
        tool: r.action.tool,
        input: r.action.input,
        preview: r.preview,
      })
    }
  }

  // 6. Сохранить assistant-ответ в БД.
  //    ВАЖНО: сохраняем ТОЛЬКО text-блоки. Если в последнем assistant message
  //    остались tool_use без парных tool_result (max_iterations) — следующий
  //    запрос упадёт на orphan tool_use_id. Чистый текст всегда безопасен.
  await prisma.borisMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      // Json column принимает string. Финальный текст result.finalText уже
      // собран из всех text-блоков последнего ответа модели.
      content: result.finalText as unknown as Prisma.InputJsonValue,
    },
  })

  // 7. Обновить lastMessageAt беседы (одной запись — не делаем отдельную транзакцию).
  await prisma.borisConversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  })

  // 8. Если есть pending — создать BorisPendingAction и собрать preview.
  if (pendingActions.length > 0) {
    const preview = buildMultiActionPreview(pendingActions)
    const pending = await prisma.borisPendingAction.create({
      data: {
        conversationId: conversation.id,
        // actions храним как Json-массив объектов {tool, input}; executor.ts читает его обратно.
        actions: pendingActions as unknown as Prisma.InputJsonValue,
        previewText: preview,
        expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS),
      },
    })

    return {
      conversationId: conversation.id,
      reply: result.finalText,
      pendingActionId: pending.id,
      preview,
    }
  }

  return {
    conversationId: conversation.id,
    reply: result.finalText,
  }
}
