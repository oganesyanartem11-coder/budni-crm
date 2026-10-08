import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Callback scope 'boris' (✅ Подтвердить / ✗ Отмена):
 *  - сбой editMessageText после выполнения НЕ превращается в «Ошибка выполнения»
 *    (изменения уже применены) — итог уходит новым сообщением;
 *  - ошибки/подписи экранируются (HTML parse mode);
 *  - итог длиннее лимита Telegram — частями ≤ 4096.
 */

const { mockRegister, mockIdentify, mockExecute, mockPrisma } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockIdentify: vi.fn(),
  mockExecute: vi.fn(),
  mockPrisma: {
    borisPendingAction: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

vi.mock('./identify-user', () => ({ identifyTelegramUser: mockIdentify }))
vi.mock('./callback-router', () => ({ registerCallbackHandler: mockRegister }))
vi.mock('@/lib/boris/agent', () => ({ chatWithBoris: vi.fn() }))
vi.mock('@/lib/boris/executor', () => ({ executePendingAction: mockExecute }))
vi.mock('@/lib/boris/preview', () => ({ TOOL_TITLES: { cancel_order: 'Отмена <заказа>' } }))
vi.mock('@/lib/llm/agent-loop', () => ({ runAgentLoop: vi.fn() }))
vi.mock('@/lib/ai/models', () => ({ getBorisModel: () => 'test-model' }))
vi.mock('@/lib/boris/personality', () => ({ getBorisSystemPrompt: () => 'p' }))
vi.mock('@/lib/boris/tools', () => ({ BORIS_READ_TOOLS: [] }))
vi.mock('@/lib/boris/context-classifier', () => ({ classifyMessageRelatesToBoris: vi.fn() }))
vi.mock('@/lib/boris/group-reply-tracker', () => ({
  getLastBorisGroupReply: vi.fn(),
  recordBorisGroupReply: vi.fn(),
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import { formatBorisExecutionSummary } from './boris-handler'

const handler = mockRegister.mock.calls.find((c) => c[0].scope === 'boris')![0] as {
  handle: (ctx: unknown, action: string, id: string) => Promise<void>
}

function makeCtx() {
  return {
    chat: { type: 'private', id: 1 },
    from: { id: 42 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIdentify.mockResolvedValue({ id: 'u1', role: 'ADMIN_PRO' })
  mockPrisma.borisPendingAction.findUnique.mockResolvedValue({
    id: 'pa1',
    previewText: '<b>План</b>',
    executedAt: null,
    cancelledAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    conversation: { userId: 'u1' },
  })
  mockPrisma.borisPendingAction.update.mockResolvedValue({})
})

describe('formatBorisExecutionSummary', () => {
  it('экранирует ошибки и подписи', () => {
    const text = formatBorisExecutionSummary([
      { tool: 'cancel_order', ok: false, error: 'status <LOCKED> & co' },
      { tool: 'x', ok: true, data: { label: 'пн <5>' } },
    ])
    expect(text).toBe('❌ Отмена &lt;заказа&gt;: status &lt;LOCKED&gt; &amp; co\n✅ пн &lt;5&gt;')
  })
})

describe("callback 'boris' confirm", () => {
  it('успех → правим сообщение с итогом', async () => {
    mockExecute.mockResolvedValue({ ok: true, results: [{ tool: 'x', ok: true, data: { label: 'Готово' } }] })
    const ctx = makeCtx()
    await handler.handle(ctx, 'confirm', 'pa1')
    expect(ctx.editMessageText).toHaveBeenCalledWith('<b>План</b>\n\n✅ Готово', { parse_mode: 'HTML' })
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Ошибка выполнения' }),
    )
  })

  it('правка упала после выполнения → не «Ошибка выполнения», итог новым сообщением', async () => {
    mockExecute.mockResolvedValue({ ok: true, results: [{ tool: 'x', ok: true, data: { label: 'Готово' } }] })
    const ctx = makeCtx()
    ctx.editMessageText.mockRejectedValue(new Error('message is not modified'))
    await handler.handle(ctx, 'confirm', 'pa1')
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Ошибка выполнения' }),
    )
    expect(ctx.reply).toHaveBeenCalledWith('✅ Готово', { parse_mode: 'HTML' })
  })

  it('выполнение кинуло → «Ошибка выполнения»', async () => {
    mockExecute.mockRejectedValue(new Error('db'))
    const ctx = makeCtx()
    await handler.handle(ctx, 'confirm', 'pa1')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Ошибка выполнения', show_alert: true })
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  it('итог длиннее 4096 → кнопки сняты, итог частями ≤ 4096', async () => {
    const results = Array.from({ length: 300 }, (_, i) => ({
      tool: 'x',
      ok: true,
      data: { label: `строка номер ${i} — заказ обновлён до 30 порций` },
    }))
    mockExecute.mockResolvedValue({ ok: true, results })
    const ctx = makeCtx()
    await handler.handle(ctx, 'confirm', 'pa1')
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.reply.mock.calls.length).toBeGreaterThan(1)
    for (const [part] of ctx.reply.mock.calls) expect((part as string).length).toBeLessThanOrEqual(4096)
  })
})

describe("callback 'boris' cancel", () => {
  it('сбой правки при отмене не роняет обработку', async () => {
    const ctx = makeCtx()
    ctx.editMessageText.mockRejectedValue(new Error('too old'))
    await expect(handler.handle(ctx, 'cancel', 'pa1')).resolves.toBeUndefined()
    expect(mockPrisma.borisPendingAction.update).toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('✗ Отменено', { parse_mode: 'HTML' })
  })
})
