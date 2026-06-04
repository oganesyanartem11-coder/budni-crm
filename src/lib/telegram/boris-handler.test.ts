import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * П4: поведенческие тесты handleBorisMessage по веткам chatType × identify.
 *
 * Мокаем все внешние зависимости (LLM, БД, identify), чтобы проверить ТОЛЬКО
 * маршрутизацию доступа. Ключевые гарантии:
 *  - group + user=null → НЕ отвечаем «не нашёл», идём в stateless read-only
 *    (runAgentLoop с READ-tools), chatWithBoris НЕ вызывается, mutate невозможен.
 *  - private + user=null → reply «не нашёл», ни LLM, ни chatWithBoris.
 *  - group + user есть → обычный путь через chatWithBoris.
 */

const identifyTelegramUser = vi.fn()
const chatWithBoris = vi.fn()
const runAgentLoop = vi.fn()
const borisConversationFindFirst = vi.fn()
const borisMetricsCount = vi.fn()

vi.mock('./identify-user', () => ({
  identifyTelegramUser: (...args: unknown[]) => identifyTelegramUser(...args),
}))
// registerCallbackHandler — side-effect при импорте модуля; мокаем no-op.
vi.mock('./callback-router', () => ({
  registerCallbackHandler: vi.fn(),
}))
vi.mock('@/lib/boris/agent', () => ({
  chatWithBoris: (...args: unknown[]) => chatWithBoris(...args),
}))
vi.mock('@/lib/boris/executor', () => ({
  executePendingAction: vi.fn(),
}))
vi.mock('@/lib/boris/preview', () => ({
  TOOL_TITLES: {},
}))
vi.mock('@/lib/llm/agent-loop', () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoop(...args),
}))
vi.mock('@/lib/ai/models', () => ({
  getBorisModel: () => 'test-model',
}))
vi.mock('@/lib/boris/personality', () => ({
  getBorisSystemPrompt: () => 'test-prompt',
}))
vi.mock('@/lib/boris/tools', () => ({
  BORIS_READ_TOOLS: [{ name: 'find_orders' }],
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisConversation: { findFirst: (...a: unknown[]) => borisConversationFindFirst(...a) },
    borisMetrics: { count: (...a: unknown[]) => borisMetricsCount(...a) },
  },
}))

import { handleBorisMessage } from './boris-handler'

type FakeCtx = {
  chat: { type: string }
  message: { text: string }
  from: { id: number }
  reply: ReturnType<typeof vi.fn>
  replyWithChatAction: ReturnType<typeof vi.fn>
}

function makeCtx(chatType: string, text: string): FakeCtx {
  return {
    chat: { type: chatType },
    message: { text },
    from: { id: 42 },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
  }
}

const NOT_IDENTIFIED = 'Не нашёл тебя в системе. Обратись к админу за подключением.'

beforeEach(() => {
  vi.clearAllMocks()
  runAgentLoop.mockResolvedValue({
    finalText: 'Сегодня 120 порций.',
    messages: [],
    toolCalls: [],
    iterations: 1,
    stopReason: 'end_turn',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  })
  chatWithBoris.mockResolvedValue({ conversationId: 'conv1', reply: 'Ок, менеджер.' })
  borisConversationFindFirst.mockResolvedValue(null)
  borisMetricsCount.mockResolvedValue(0)
})

describe('handleBorisMessage — ветка group + user=null (П4)', () => {
  it('НЕ отвечает «не нашёл», идёт в stateless read-only (runAgentLoop), chatWithBoris не вызван', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    const ctx = makeCtx('group', 'Борис, сколько порций сегодня?')

    await handleBorisMessage(ctx as never)

    // Не «не нашёл».
    const replied = ctx.reply.mock.calls.map((c) => c[0])
    expect(replied).not.toContain(NOT_IDENTIFIED)
    // Ответ из stateless-пути.
    expect(ctx.reply).toHaveBeenCalledWith('Сегодня 120 порций.', { parse_mode: 'HTML' })
    // Использован именно read-only loop, НЕ chatWithBoris (никакого персиста/mutate).
    expect(runAgentLoop).toHaveBeenCalledTimes(1)
    expect(chatWithBoris).not.toHaveBeenCalled()
  })

  it('stateless-путь использует ТОЛЬКО READ-tools (mutate невозможен)', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    const ctx = makeCtx('supergroup', 'Борис, поменяй заказ Ромашке на 50')

    await handleBorisMessage(ctx as never)

    expect(runAgentLoop).toHaveBeenCalledTimes(1)
    const arg = runAgentLoop.mock.calls[0][0] as { tools: { name: string }[] }
    // Переданы read-tools; мок BORIS_READ_TOOLS = [{name:'find_orders'}].
    expect(arg.tools).toEqual([{ name: 'find_orders' }])
    // Никаких mutate-инструментов по имени.
    const names = arg.tools.map((t) => t.name)
    expect(names).not.toContain('edit_order_portions')
    expect(names).not.toContain('cancel_order')
    expect(names).not.toContain('create_one_time_order')
    // БД-персист диалога не трогаем (stateless).
    expect(borisConversationFindFirst).not.toHaveBeenCalled()
  })
})

describe('handleBorisMessage — ветка private + user=null', () => {
  it('отвечает «не нашёл», LLM и chatWithBoris НЕ вызываются', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    const ctx = makeCtx('private', 'привет')

    await handleBorisMessage(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith(NOT_IDENTIFIED)
    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(chatWithBoris).not.toHaveBeenCalled()
  })
})

describe('handleBorisMessage — ветка group + user есть', () => {
  it('идёт обычным путём через chatWithBoris (chatType=group), stateless loop не используется', async () => {
    identifyTelegramUser.mockResolvedValue({
      id: 'u1',
      name: 'Анна',
      role: 'MANAGER',
      isActive: true,
    })
    const ctx = makeCtx('group', 'Борис, что по сегодняшнему дню?')

    await handleBorisMessage(ctx as never)

    expect(chatWithBoris).toHaveBeenCalledTimes(1)
    const arg = chatWithBoris.mock.calls[0][0] as { chatType: string; userId: string }
    expect(arg.chatType).toBe('group')
    expect(arg.userId).toBe('u1')
    // Stateless-путь НЕ используется когда есть user.
    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('Ок, менеджер.', { parse_mode: 'HTML' })
  })
})

describe('handleBorisMessage — игнор не-нашей зоны', () => {
  it('group без упоминания «Борис» → молчим (ни reply, ни LLM)', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    const ctx = makeCtx('group', 'просто болтаем без обращения')

    await handleBorisMessage(ctx as never)

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(chatWithBoris).not.toHaveBeenCalled()
  })
})
