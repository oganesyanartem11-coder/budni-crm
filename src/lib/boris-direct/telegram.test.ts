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
  mockFindRecentLeadCandidates,
  mockMarkDealWon,
  mockCancelDeal,
  mockAnswerDirectFreeText,
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
    mockFindRecentLeadCandidates: vi.fn(),
    mockMarkDealWon: vi.fn(),
    mockCancelDeal: vi.fn(),
    mockAnswerDirectFreeText: vi.fn(),
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
vi.mock('./chat-reply', () => ({
  answerDirectFreeText: mockAnswerDirectFreeText,
}))
// Чистые функции deals (parseDealCommand/findLeadMatches) — РЕАЛЬНЫЕ; мокаем только I/O.
vi.mock('./deals', async (importActual) => {
  const actual = await importActual<typeof import('./deals')>()
  return {
    ...actual,
    findRecentLeadCandidates: mockFindRecentLeadCandidates,
    markDealWon: mockMarkDealWon,
    cancelDeal: mockCancelDeal,
  }
})

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
  mockFindRecentLeadCandidates.mockResolvedValue([])
  mockMarkDealWon.mockResolvedValue(undefined)
  mockCancelDeal.mockResolvedValue(undefined)
  mockAnswerDirectFreeText.mockResolvedValue('По кампании: расход у нормы, синонимы по запросам не размечены — покажу пофразный расход.')
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

// РОЛЬ «ВЕДЕНИЕ ДИРЕКТА» ОТКЛЮЧЕНА НАСОВСЕМ (решение владельца): кампания на
// автостратегии Яндекса. Команды владельца и кнопки одобрения получают ранний
// выход «ведение Директа отключено» БЕЗ обращения к состоянию/кабинету/LLM.
// Passthrough-поведение (не Директ-чат / без обращения / без текста) сохранено.
const DISABLED = 'Ведение Директа отключено'

describe('handleDirectChatMessage — роль Директа ОТКЛЮЧЕНА', () => {
  it('не Директ-чат → next(), ничего не меняем', async () => {
    const ctx = makeCtx(-555, 'Борис, стоп')
    const next = vi.fn().mockResolvedValue(undefined)
    await handleDirectChatMessage(asCtx(ctx), next)
    expect(next).toHaveBeenCalledOnce()
    expect(mockSetDirectFrozen).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('чат Директа, БЕЗ обращения «Борис/Боря» → next() (свободный контур не наш)', async () => {
    const ctx = makeCtx(-100777, 'просто сообщение в чате без обращения')
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

  // Любая обращённая команда роли в чате Директа → «отключено», next() не зовём,
  // ни одной операции роли (режим/стоп-кран/гейт/откат/рассуждение/звонок/сделка).
  const disabledCommands = [
    'Борис, стоп',
    'боря стоп',
    'Борис, продолжай',
    'борис, боевой',
    'Борис, наблюдение',
    'Борис, откати последнее',
    'Борис, верни гейт',
    'Борис, статус',
    'Борис, что ты понял',
    'Борис, чему научился',
    'Борис, почему доставка обедов в офис',
    'Борис, звонок 79991234567',
    'Борис, сделка 79991234567 150000',
    'Борис, привет',
    'Борис, что по кампании?',
  ]
  it.each(disabledCommands)(
    '«%s» → ответ «отключено», next() не зовём, состояние/кабинет/LLM не трогаем',
    async (text) => {
      const ctx = makeCtx(-100777, text)
      const next = vi.fn().mockResolvedValue(undefined)
      await handleDirectChatMessage(asCtx(ctx), next)
      expect(next).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining(DISABLED),
        { parse_mode: 'HTML' }
      )
      expect(mockSetDirectFrozen).not.toHaveBeenCalled()
      expect(mockSetDirectMode).not.toHaveBeenCalled()
      expect(mockSetAutoNegativesEnabled).not.toHaveBeenCalled()
      expect(mockRevertLastAction).not.toHaveBeenCalled()
      expect(mockExplainPhrase).not.toHaveBeenCalled()
      expect(mockAnswerDirectFreeText).not.toHaveBeenCalled()
      expect(mockGetActiveLessonsReport).not.toHaveBeenCalled()
      expect(mockMarkDealWon).not.toHaveBeenCalled()
      expect(mockCancelDeal).not.toHaveBeenCalled()
      expect(mockActionLogCreate).not.toHaveBeenCalled()
    }
  )
})

describe("callback-handler scope 'bdir' — роль Директа ОТКЛЮЧЕНА", () => {
  function getHandler() {
    const handler = registeredHandlers.find((h) => h.scope === 'bdir')
    expect(handler).toBeDefined()
    return handler!.handle as (ctx: Context, action: string, id: string) => Promise<void>
  }

  it('регистрируется при импорте модуля со scope bdir', () => {
    expect(registeredHandlers.some((h) => h.scope === 'bdir')).toBe(true)
  })

  // Даже случайное нажатие старой кнопки «✅ Да»/«❌ Нет» → «отключено», кнопки
  // снимаем, decideProposal НЕ зовём (никакого решения/применения предложения).
  it.each(['accept', 'reject', 'boom'])(
    'action «%s» → answer «отключено», кнопки снимаем, decideProposal не зовём',
    async (action) => {
      const ctx = makeCtx(-100777)
      await getHandler()(asCtx(ctx), action, 'prop1')
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: DISABLED })
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith(undefined)
      expect(mockDecideProposal).not.toHaveBeenCalled()
      expect(ctx.reply).not.toHaveBeenCalled()
    }
  )

  it('editMessageReplyMarkup упал (старое сообщение) → не падаем, decideProposal не зовём', async () => {
    const ctx = makeCtx(-100777)
    ctx.editMessageReplyMarkup.mockRejectedValue(new Error('message is not modified'))
    await expect(getHandler()(asCtx(ctx), 'accept', 'prop5')).resolves.toBeUndefined()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: DISABLED })
    expect(mockDecideProposal).not.toHaveBeenCalled()
  })
})
