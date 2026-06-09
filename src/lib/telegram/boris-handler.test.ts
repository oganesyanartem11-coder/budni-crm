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
const borisMessageFindFirst = vi.fn()
const classifyMessageRelatesToBoris = vi.fn()
const getLastBorisGroupReply = vi.fn()
const recordBorisGroupReply = vi.fn()

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
vi.mock('@/lib/boris/context-classifier', () => ({
  classifyMessageRelatesToBoris: (...args: unknown[]) =>
    classifyMessageRelatesToBoris(...args),
}))
vi.mock('@/lib/boris/group-reply-tracker', () => ({
  getLastBorisGroupReply: (...args: unknown[]) => getLastBorisGroupReply(...args),
  recordBorisGroupReply: (...args: unknown[]) => recordBorisGroupReply(...args),
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisConversation: { findFirst: (...a: unknown[]) => borisConversationFindFirst(...a) },
    borisMetrics: { count: (...a: unknown[]) => borisMetricsCount(...a) },
    borisMessage: { findFirst: (...a: unknown[]) => borisMessageFindFirst(...a) },
  },
}))

import { handleBorisMessage } from './boris-handler'

type FakeCtx = {
  chat: { type: string; id: number }
  message: { text: string; message_id: number }
  from: { id: number }
  reply: ReturnType<typeof vi.fn>
  replyWithChatAction: ReturnType<typeof vi.fn>
}

function makeCtx(chatType: string, text: string, messageId = 100): FakeCtx {
  return {
    chat: { type: chatType, id: -100123 },
    message: { text, message_id: messageId },
    from: { id: 42 },
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
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
  borisMessageFindFirst.mockResolvedValue(null)
  classifyMessageRelatesToBoris.mockResolvedValue({ relates: true, confidence: 1 })
  getLastBorisGroupReply.mockResolvedValue(null)
  recordBorisGroupReply.mockResolvedValue(undefined)
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

describe('handleBorisMessage — Haiku-ветка (F-grp-1)', () => {
  // Без упоминания «Борис», но в пределах окна (messageId - lastReply <= 20) →
  // shouldRespondInGroup вернёт needsHaiku=true.
  it('нет ответа Бори в чате (borisMessage.findFirst → null) → молчим, классификатор НЕ зовём', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    // В окне: последний ответ Бори — messageId 95, новое — 100 (дистанция 5),
    // updatedAt свежий (внутри TTL).
    getLastBorisGroupReply.mockResolvedValue({
      messageId: 95,
      updatedAt: new Date(),
    })
    borisMessageFindFirst.mockResolvedValue(null)
    const ctx = makeCtx('group', 'это вообще неправильно', 100)

    await handleBorisMessage(ctx as never)

    expect(classifyMessageRelatesToBoris).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(chatWithBoris).not.toHaveBeenCalled()
  })

  it('есть ответ Бори → классификатор зовётся с lastBorisReply (извлечённый непустой текст)', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    getLastBorisGroupReply.mockResolvedValue({
      messageId: 95,
      updatedAt: new Date(),
    })
    borisMessageFindFirst.mockResolvedValue({
      content: [
        { type: 'text', text: 'Сегодня 120 порций для Ромашки.' },
        { type: 'tool_use', name: 'find_orders', input: {} },
      ],
    })
    // relates=false → дальше не идём, но факт вызова классификатора с контекстом важен.
    classifyMessageRelatesToBoris.mockResolvedValue({ relates: false, confidence: 0.9 })
    const ctx = makeCtx('group', 'спасибо, понял', 100)

    await handleBorisMessage(ctx as never)

    expect(classifyMessageRelatesToBoris).toHaveBeenCalledTimes(1)
    const arg = classifyMessageRelatesToBoris.mock.calls[0][0] as {
      text: string
      lastBorisReply: string
    }
    expect(arg.text).toBe('спасибо, понял')
    expect(arg.lastBorisReply).toBe('Сегодня 120 порций для Ромашки.')
    // relates=false → молчим.
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(chatWithBoris).not.toHaveBeenCalled()
  })

  it('ответ Бори старше TTL (time-bound where отфильтровал) → findFirst=null → молчим, классификатор НЕ зовём (V-haiku-no-timebound)', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    // Окно «слушаю» открыто по messageId-дистанции (95 vs 100), updatedAt свежий —
    // shouldRespondInGroup даёт needsHaiku=true.
    getLastBorisGroupReply.mockResolvedValue({
      messageId: 95,
      updatedAt: new Date(),
    })
    // Ассистентское сообщение Бори В ЧАТЕ существует, но старше TTL-окна:
    // time-bound where (createdAt >= now - TTL) его исключает → Prisma вернёт null.
    // Мок воспроизводит результат отфильтрованной выборки.
    borisMessageFindFirst.mockResolvedValue(null)
    const ctx = makeCtx('group', 'это вообще неправильно', 100)

    await handleBorisMessage(ctx as never)

    // findFirst был вызван с time-bound where (createdAt.gte присутствует).
    expect(borisMessageFindFirst).toHaveBeenCalledTimes(1)
    const where = borisMessageFindFirst.mock.calls[0][0].where as {
      createdAt?: { gte?: Date }
    }
    expect(where.createdAt?.gte).toBeInstanceOf(Date)
    // Протухший контекст → молчим тем же путём, что no_prior: classifier не зовём.
    expect(classifyMessageRelatesToBoris).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(runAgentLoop).not.toHaveBeenCalled()
    expect(chatWithBoris).not.toHaveBeenCalled()
  })

  it('борис-фетч по chatId: findFirst фильтрует role=assistant + conversation.chatId', async () => {
    identifyTelegramUser.mockResolvedValue(null)
    getLastBorisGroupReply.mockResolvedValue({
      messageId: 95,
      updatedAt: new Date(),
    })
    borisMessageFindFirst.mockResolvedValue({
      content: [{ type: 'text', text: 'ответ Бори' }],
    })
    const ctx = makeCtx('group', 'а почему так', 100)

    await handleBorisMessage(ctx as never)

    expect(borisMessageFindFirst).toHaveBeenCalledWith({
      where: {
        role: 'assistant',
        conversation: { chatId: '-100123' },
        // V-haiku-no-timebound: time-bound окно TTL добавлено к where.
        createdAt: { gte: expect.any(Date) },
      },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    })
  })
})
