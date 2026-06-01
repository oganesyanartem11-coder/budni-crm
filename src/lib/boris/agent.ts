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
import { clipConversationWindow } from '@/lib/llm/conversation-window'
import { getBorisModel } from '@/lib/ai/models'
import { getBorisSystemPrompt } from './personality'
import { BORIS_TOOLS, BORIS_READ_TOOLS } from './tools'
import { buildMultiActionPreview, type PendingActionForPreview } from './preview'
import { trackBorisCall } from './metrics/track'
import { BORIS_HISTORY_WINDOW, BORIS_CONVERSATION_TTL_MINUTES } from './config'
import { prisma } from '@/lib/db/prisma'
import { BorisMetricSource, type BorisConversation, type Prisma, type UserRole } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000

/**
 * 7.16.D: тянем из БД чуть больше, чем хотим в API — это даёт
 * clipConversationWindow материал, чтобы при необходимости расширить окно
 * назад и захватить parent assistant перед orphan tool_result.
 */
const HISTORY_DB_FETCH = BORIS_HISTORY_WINDOW + 5

export interface ChatWithBorisInput {
  userId: string
  conversationId?: string
  userText: string
  /** Тип чата откуда пришло сообщение. Влияет на доступные tools:
   *  в group/supergroup — только READ-tools (mutate отключаются). */
  chatType: 'private' | 'group' | 'supergroup' | 'channel'
  /** Роль пользователя. MUTATE-tools доступны ТОЛЬКО для ADMIN_PRO. */
  userRole: UserRole
}

export interface ChatWithBorisResult {
  conversationId: string
  reply: string
  pendingActionId?: string
  preview?: string
}

/**
 * 7.16.D: подобрать активную беседу с учётом TTL (BORIS_CONVERSATION_TTL_MINUTES).
 *
 * - Если передан explicit conversationId — переиспользуем его как есть
 *   (внешний код знает что делает; не закрываем по TTL).
 * - Иначе берём последнюю open беседу userId. Если lastMessageAt свежий —
 *   reuse. Если stale — закрываем (closedAt=now, expiresAt=lastMessageAt+TTL)
 *   и создаём новую. Если нет open беседы — создаём.
 *
 * Lazy auto-close работает per-request — фоновый cron не нужен.
 */
async function resolveActiveConversation(
  userId: string,
  conversationId?: string,
  now: Date = new Date(),
): Promise<BorisConversation> {
  if (conversationId) {
    const explicit = await prisma.borisConversation.findFirst({
      where: { id: conversationId, userId, closedAt: null },
    })
    if (explicit) return explicit
  }

  const ttlCutoff = new Date(now.getTime() - BORIS_CONVERSATION_TTL_MINUTES * 60_000)
  const last = await prisma.borisConversation.findFirst({
    where: { userId, closedAt: null },
    orderBy: { lastMessageAt: 'desc' },
  })

  if (last && last.lastMessageAt >= ttlCutoff) {
    return last
  }

  if (last) {
    // Stale: фиксируем фактическое закрытие (closedAt=now) и теоретический
    // expiry (lastMessageAt+TTL) для аудита «когда фактически истёк бы TTL».
    const expiresAt = new Date(
      last.lastMessageAt.getTime() + BORIS_CONVERSATION_TTL_MINUTES * 60_000,
    )
    await prisma.borisConversation.update({
      where: { id: last.id },
      data: { closedAt: now, expiresAt },
    })
  }

  return prisma.borisConversation.create({
    data: { userId },
  })
}

export async function chatWithBoris(input: ChatWithBorisInput): Promise<ChatWithBorisResult> {
  // 1. Подобрать беседу с учётом TTL.
  const conversation = await resolveActiveConversation(
    input.userId,
    input.conversationId,
  )

  // 2. Загрузить чуть больше чем целевое окно (запас на расширение в clip).
  const history = await prisma.borisMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_DB_FETCH,
  })
  history.reverse()

  const rawMessages: Anthropic.Messages.MessageParam[] = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      // content уже сохранён в Anthropic-формате (string или ContentBlock[]).
      content: m.content as Anthropic.Messages.MessageParam['content'],
    }))

  // 7.16.D: безопасно обрезаем до BORIS_HISTORY_WINDOW (расширяем назад
  // если граница попадает между tool_use и tool_result; дропаем orphan
  // user-сообщения если расширение исчерпало лимит).
  const historyMessages = clipConversationWindow(
    rawMessages,
    BORIS_HISTORY_WINDOW,
  )

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
  // 7.32: два защитных яруса на mutate-tools.
  // Ярус 1 (chat-type): mutate только в private. Ярус 2 (role): mutate только ADMIN_PRO.
  // В группе ИЛИ для не-ADMIN_PRO — отдаём LLM только READ-tools (mutate скрыты физически).
  const isPrivate = input.chatType === 'private'
  const isAdminPro = input.userRole === 'ADMIN_PRO'
  const canMutate = isPrivate && isAdminPro
  const tools = canMutate ? BORIS_TOOLS : BORIS_READ_TOOLS

  const startedAt = Date.now()
  let result
  try {
    result = await runAgentLoop({
      model: getBorisModel(),
      systemPrompt: getBorisSystemPrompt(),
      initialMessages: [...historyMessages, userMessage],
      tools,
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
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
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
