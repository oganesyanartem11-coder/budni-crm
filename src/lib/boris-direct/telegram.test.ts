import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Context } from 'grammy'

const {
  mockSendTelegramMessage,
  mockReadDirectChatId,
  mockRegisterCallbackHandler,
  registeredHandlers,
  mockActionLogCreate,
  mockGetDirectRoleState,
  mockSetDirectMode,
  mockSetDirectFrozen,
  mockSetAutoNegativesEnabled,
  mockRevertLastAction,
  mockDecideProposal,
  mockGetActiveLessonsReport,
  mockExplainPhrase,
} = vi.hoisted(() => {
  // Регистрация scope 'bdir' происходит ПРИ ИМПОРТЕ модуля — сохраняем handler
  // в замыкании, т.к. vi.clearAllMocks() в beforeEach стирает mock.calls.
  const registeredHandlers: Array<{
    scope: string
    handle: (ctx: unknown, action: string, id: string) => Promise<void>
  }> = []
  return {
    mockSendTelegramMessage: vi.fn(),
    mockReadDirectChatId: vi.fn(),
    mockRegisterCallbackHandler: vi.fn((handler: (typeof registeredHandlers)[number]) => {
      registeredHandlers.push(handler)
    }),
    registeredHandlers,
    mockActionLogCreate: vi.fn(),
    mockGetDirectRoleState: vi.fn(),
    mockSetDirectMode: vi.fn(),
    mockSetDirectFrozen: vi.fn(),
    mockSetAutoNegativesEnabled: vi.fn(),
    mockRevertLastAction: vi.fn(),
    mockDecideProposal: vi.fn(),
    mockGetActiveLessonsReport: vi.fn(),
    mockExplainPhrase: vi.fn(),
  }
})

vi.mock('@/lib/telegram/send', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}))
vi.mock('@/lib/telegram/env', () => ({
  readDirectChatId: mockReadDirectChatId,
}))
vi.mock('@/lib/telegram/callback-router', () => ({
  registerCallbackHandler: mockRegisterCallbackHandler,
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    borisDirectActionLog: { create: mockActionLogCreate },
  },
}))
vi.mock('./state', () => ({
  getDirectRoleState: mockGetDirectRoleState,
  setDirectMode: mockSetDirectMode,
  setDirectFrozen: mockSetDirectFrozen,
  setAutoNegativesEnabled: mockSetAutoNegativesEnabled,
}))
vi.mock('./rollback', () => ({
  revertLastAction: mockRevertLastAction,
}))
vi.mock('./proposals', () => ({
  decideProposal: mockDecideProposal,
}))
vi.mock('./lessons', () => ({
  getActiveLessonsReport: mockGetActiveLessonsReport,
}))
vi.mock('./explain', () => ({
  explainPhrase: mockExplainPhrase,
}))

import { sendToDirectChat, isDirectChat, handleDirectChatMessage } from './telegram'

const DIRECT_CHAT_ID = '-100777'

interface MockCtx {
  chat?: { id: number | string }
  message?: { text?: string }
  reply: ReturnType<typeof vi.fn>
  answerCallbackQuery: ReturnType<typeof vi.fn>
  editMessageReplyMarkup: ReturnType<typeof vi.fn>
}

function makeCtx(chatId: number | string | undefined, text?: string): MockCtx {
  return {
    chat: chatId === undefined ? undefined : { id: chatId },
    message: text === undefined ? undefined : { text },
    reply: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
  }
}

const asCtx = (ctx: MockCtx) => ctx as unknown as Context

beforeEach(() => {
  vi.clearAllMocks()
  mockReadDirectChatId.mockReturnValue(DIRECT_CHAT_ID)
  mockSendTelegramMessage.mockResolvedValue({ ok: true })
  mockActionLogCreate.mockResolvedValue({})
  mockGetDirectRoleState.mockResolvedValue({
    mode: 'OBSERVE',
    frozen: false,
    autoNegativesEnabled: false,
  })
  mockSetDirectMode.mockResolvedValue(undefined)
  mockSetDirectFrozen.mockResolvedValue(undefined)
  mockSetAutoNegativesEnabled.mockResolvedValue(undefined)
  mockGetActiveLessonsReport.mockResolvedValue('Мои уроки: пока пусто.')
  mockExplainPhrase.mockResolvedValue('Держал: тонкая, 3 клика, заявок 0.')
})

describe('sendToDirectChat', () => {
  it('шлёт в чат Директа с parseMode HTML', async () => {
    const result = await sendToDirectChat('привет')
    expect(result).toEqual({ ok: true })
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      DIRECT_CHAT_ID,
      'привет',
      expect.objectContaining({ parseMode: 'HTML' })
    )
  })

  it('env не задан (readDirectChatId кидает) → {ok:false, no_chat_id}, не падает', async () => {
    mockReadDirectChatId.mockImplementation(() => {
      throw new Error('not set')
    })
    const result = await sendToDirectChat('привет')
    expect(result).toEqual({ ok: false, error: 'no_chat_id' })
    expect(mockSendTelegramMessage).not.toHaveBeenCalled()
  })
})

describe('isDirectChat', () => {
  it('совпадение по String(chatId)', () => {
    expect(isDirectChat(-100777)).toBe(true)
    expect(isDirectChat('-100777')).toBe(true)
    expect(isDirectChat(-200999)).toBe(false)
    expect(isDirectChat(undefined)).toBe(false)
  })

  it('env кидает → false', () => {
    mockReadDirectChatId.mockImplementation(() => {
      throw new Error('not set')
    })
    expect(isDirectChat(-100777)).toBe(false)
  })
})

describe('handleDirectChatMessage — команды владельца', () => {
  it('не Директ-чат → next(), ничего не меняем', async () => {
    const ctx = makeCtx(-555, 'Борис, стоп')
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
    expect(mockSetDirectFrozen).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('«Борис, почему <фраза>» → explainPhrase(фраза) + ответ HTML, не команда состояния', async () => {
    const ctx = makeCtx(-100777, 'Борис, почему доставка обедов в офис')
    const next = vi.fn()
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).not.toHaveBeenCalled()
    expect(mockExplainPhrase).toHaveBeenCalledWith('доставка обедов в офис')
    expect(ctx.reply).toHaveBeenCalledWith(
      'Держал: тонкая, 3 клика, заявок 0.',
      expect.objectContaining({ parse_mode: 'HTML' })
    )
    expect(mockSetDirectFrozen).not.toHaveBeenCalled()
  })

  it('«Борис, почему» без фразы → next() (обычный Борис), explainPhrase не зовём', async () => {
    const ctx = makeCtx(-100777, 'Борис, почему')
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
    expect(mockExplainPhrase).not.toHaveBeenCalled()
  })

  it('«Борис, стоп» → setDirectFrozen(true) + ответ + лог freeze.change', async () => {
    const ctx = makeCtx(-100777, 'Борис, стоп')
    const next = vi.fn()
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).not.toHaveBeenCalled()
    expect(mockSetDirectFrozen).toHaveBeenCalledWith(true)
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Стоп-кран включён'),
      { parse_mode: 'HTML' }
    )
    expect(mockActionLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'freeze.change',
        targetType: 'campaign',
        applied: true,
        reason: 'команда владельца в чате Директа',
      }),
    })
  })

  it('«боря стоп» (без запятой, второй префикс) — тоже команда', async () => {
    const ctx = makeCtx(-100777, 'боря стоп')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockSetDirectFrozen).toHaveBeenCalledWith(true)
  })

  it('«Борис, продолжай» → setDirectFrozen(false)', async () => {
    const ctx = makeCtx(-100777, 'Борис, продолжай')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockSetDirectFrozen).toHaveBeenCalledWith(false)
    expect(ctx.reply).toHaveBeenCalled()
  })

  it('«борис, боевой» → setDirectMode(LIVE) + лог mode.change + предупреждение', async () => {
    mockGetDirectRoleState.mockResolvedValue({
      mode: 'LIVE',
      frozen: false,
      autoNegativesEnabled: false,
    })
    const ctx = makeCtx(-100777, 'борис, боевой')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockSetDirectMode).toHaveBeenCalledWith('LIVE')
    expect(mockActionLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'mode.change', mode: 'LIVE' }),
    })
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('реально применяются'),
      { parse_mode: 'HTML' }
    )
  })

  it('«Борис, наблюдение» → setDirectMode(OBSERVE)', async () => {
    const ctx = makeCtx(-100777, 'Борис, наблюдение')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockSetDirectMode).toHaveBeenCalledWith('OBSERVE')
  })

  it('«Борис, откати последнее» → revertLastAction, ответ = result.message', async () => {
    mockRevertLastAction.mockResolvedValue({ ok: true, message: 'Откатил ставку обратно.' })
    const ctx = makeCtx(-100777, 'Борис, откати последнее')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockRevertLastAction).toHaveBeenCalledOnce()
    expect(ctx.reply).toHaveBeenCalledWith('Откатил ставку обратно.', { parse_mode: 'HTML' })
  })

  it('«Борис, верни гейт» → setAutoNegativesEnabled(false) + лог gate.change', async () => {
    const ctx = makeCtx(-100777, 'Борис, верни гейт')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    expect(mockSetAutoNegativesEnabled).toHaveBeenCalledWith(false)
    expect(mockActionLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'gate.change' }),
    })
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Гейт спорных минусов снова на месте'),
      { parse_mode: 'HTML' }
    )
  })

  it('«Борис, статус» → сводка режим/стоп-кран/гейт', async () => {
    mockGetDirectRoleState.mockResolvedValue({
      mode: 'OBSERVE',
      frozen: true,
      autoNegativesEnabled: false,
    })
    const ctx = makeCtx(-100777, 'Борис, статус')
    await handleDirectChatMessage(asCtx(ctx), vi.fn())
    const text = ctx.reply.mock.calls[0][0] as string
    expect(text).toContain('наблюдение')
    expect(text).toContain('Стоп-кран')
    expect(text).toContain('Гейт')
  })

  it('«Борис, что ты понял» → ответ текстом getActiveLessonsReport', async () => {
    mockGetActiveLessonsReport.mockResolvedValue('Вот что я понял по кампании: …')
    const ctx = makeCtx(-100777, 'Борис, что ты понял')
    const next = vi.fn()
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).not.toHaveBeenCalled()
    expect(mockGetActiveLessonsReport).toHaveBeenCalledOnce()
    expect(ctx.reply).toHaveBeenCalledWith('Вот что я понял по кампании: …', {
      parse_mode: 'HTML',
    })
  })

  it('вариации «что понял» / «чему научился» — тоже команда уроков', async () => {
    for (const text of ['боря что понял', 'Борис, чему научился']) {
      const ctx = makeCtx(-100777, text)
      const next = vi.fn()
      await handleDirectChatMessage(asCtx(ctx), next)
      expect(next).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith('Мои уроки: пока пусто.', { parse_mode: 'HTML' })
    }
    expect(mockGetActiveLessonsReport).toHaveBeenCalledTimes(2)
  })

  it('«Борис, что ты думаешь» — НЕ команда уроков → next()', async () => {
    const ctx = makeCtx(-100777, 'Борис, что ты думаешь')
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
    expect(mockGetActiveLessonsReport).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('«Борис, привет» — не команда роли → next()', async () => {
    const ctx = makeCtx(-100777, 'Борис, привет')
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('сообщение без текста → next()', async () => {
    const ctx = makeCtx(-100777)
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('команда упала → ответ «смотри логи», не throw', async () => {
    mockSetDirectFrozen.mockRejectedValue(new Error('db down'))
    const ctx = makeCtx(-100777, 'Борис, стоп')
    await expect(handleDirectChatMessage(asCtx(ctx), vi.fn())).resolves.toBeUndefined()
    expect(ctx.reply).toHaveBeenCalledWith(
      'Не получилось применить команду, смотри логи',
      { parse_mode: 'HTML' }
    )
  })
})

describe("callback-handler scope 'bdir'", () => {
  function getHandler() {
    const handler = registeredHandlers.find((h) => h.scope === 'bdir')
    expect(handler).toBeDefined()
    return handler!.handle as (ctx: Context, action: string, id: string) => Promise<void>
  }

  it('регистрируется при импорте модуля со scope bdir', () => {
    expect(registeredHandlers.some((h) => h.scope === 'bdir')).toBe(true)
  })

  it('accept → decideProposal(id, accept) + answer + убрали кнопки + reply', async () => {
    mockDecideProposal.mockResolvedValue({ ok: true, summaryText: 'Принято: тест.' })
    const ctx = makeCtx(-100777)
    await getHandler()(asCtx(ctx), 'accept', 'prop1')
    expect(mockDecideProposal).toHaveBeenCalledWith('prop1', 'accept')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Принято' })
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith('Принято: тест.', { parse_mode: 'HTML' })
  })

  it('reject → decideProposal(id, reject) + answer «Отклонено»', async () => {
    mockDecideProposal.mockResolvedValue({ ok: true, summaryText: 'Отклонено: тест.' })
    const ctx = makeCtx(-100777)
    await getHandler()(asCtx(ctx), 'reject', 'prop2')
    expect(mockDecideProposal).toHaveBeenCalledWith('prop2', 'reject')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Отклонено' })
    expect(ctx.reply).toHaveBeenCalledWith('Отклонено: тест.', { parse_mode: 'HTML' })
  })

  it('уже решено (ok:false) → answer «Уже решено», без reply', async () => {
    mockDecideProposal.mockResolvedValue({ ok: false, summaryText: 'уже' })
    const ctx = makeCtx(-100777)
    await getHandler()(asCtx(ctx), 'accept', 'prop3')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Уже решено' })
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('неизвестный action → answer «Неизвестное действие», decideProposal не зовём', async () => {
    const ctx = makeCtx(-100777)
    await getHandler()(asCtx(ctx), 'boom', 'prop4')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Неизвестное действие' })
    expect(mockDecideProposal).not.toHaveBeenCalled()
  })

  it('editMessageReplyMarkup упал (старое сообщение) → всё равно reply', async () => {
    mockDecideProposal.mockResolvedValue({ ok: true, summaryText: 'Принято.' })
    const ctx = makeCtx(-100777)
    ctx.editMessageReplyMarkup.mockRejectedValue(new Error('message is not modified'))
    await getHandler()(asCtx(ctx), 'accept', 'prop5')
    expect(ctx.reply).toHaveBeenCalledWith('Принято.', { parse_mode: 'HTML' })
  })
})
