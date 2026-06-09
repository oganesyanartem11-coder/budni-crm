import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * MEGA wiring (Subagent C): маршрутизация WEEKLY-заявок в MAX-вебхуке.
 *
 * Проверяем handleMessage (surgical edit) + weekly-хелперы целиком:
 *  - WEEKLY + фото → fetch → parser('photo') → process → notify + reply;
 *  - WEEKLY + текст → parser('text') → process → notify + reply;
 *  - WEEKLY + дубль недели → InboxItem, парсер НЕ вызывается;
 *  - WEEKLY + не-image вложение → InboxItem, парсер НЕ вызывается;
 *  - не-WEEKLY → weekly-хелперы НЕ вызываются, идёт processClientMessage.
 *
 * Все внешние модули (parser/actions/sanity/notify, blob, fetch, prisma,
 * send-message) мокаем — реального IO/LLM нет.
 */

const {
  mockPrisma,
  mockFindClient,
  mockProcessClientMessage,
  mockCreateInbox,
  mockSendBotMessage,
  mockFetchAttachment,
  mockPut,
  mockParse,
  mockRunSanity,
  mockProcessWeekly,
  mockNotifyManager,
} = vi.hoisted(() => ({
  mockPrisma: {
    client: { updateMany: vi.fn() },
    clientMealConfig: { findFirst: vi.fn() },
    order: { aggregate: vi.fn() },
    weeklyOrderSubmission: { findFirst: vi.fn() },
    clientMaxUser: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  mockFindClient: vi.fn(),
  mockProcessClientMessage: vi.fn(),
  mockCreateInbox: vi.fn(),
  mockSendBotMessage: vi.fn(),
  mockFetchAttachment: vi.fn(),
  mockPut: vi.fn(),
  mockParse: vi.fn(),
  mockRunSanity: vi.fn(),
  mockProcessWeekly: vi.fn(),
  mockNotifyManager: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/bot/max-users', () => ({
  resolveClientByChatId: mockFindClient,
  promoteToActiveByChatId: vi.fn(async () => {}),
  getActiveMaxChatIdForClient: vi.fn(async () => '999'),
}))
vi.mock('@/lib/bot/process-message', () => ({ processClientMessage: mockProcessClientMessage }))
vi.mock('@/lib/bot/create-inbox-item', () => ({ createInboxItem: mockCreateInbox }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBotMessage }))
vi.mock('@/lib/max/fetch-attachment', () => ({ fetchAttachmentAsBase64: mockFetchAttachment }))
vi.mock('@vercel/blob', () => ({ put: mockPut }))
vi.mock('@/lib/weekly/parser', () => ({ parseWeeklySubmission: mockParse }))
vi.mock('@/lib/weekly/sanity-checks', () => ({ runSanityChecks: mockRunSanity }))
vi.mock('@/lib/weekly/actions', () => ({ processWeeklySubmission: mockProcessWeekly }))
vi.mock('@/lib/telegram/handlers/weekly-submission', () => ({
  notifyManagerAboutWeeklySubmission: mockNotifyManager,
}))
// Не нужны в этих тестах, но импортируются handlers.ts транзитивно.
vi.mock('@/lib/bot/log-message', () => ({ logBotMessage: vi.fn() }))
vi.mock('@/lib/bot/welcome', () => ({ pickWelcomeKind: vi.fn(), getWelcomeText: vi.fn() }))

import { handleMessage } from '@/lib/max/handlers'

type Attachment = { type: string; payload?: { url?: string } }

function makeWeeklyClient() {
  return {
    id: 'client_w',
    name: 'Недельный Клиент',
    isActive: true,
    maxChatId: '777',
    locations: [
      {
        id: 'loc_1',
        mealConfigs: [{ orderType: 'WEEKLY', isActive: true, mealType: 'LUNCH' }],
      },
    ],
  }
}

function makePlainClient() {
  return {
    id: 'client_p',
    name: 'Обычный Клиент',
    isActive: true,
    maxChatId: '888',
    locations: [
      {
        id: 'loc_1',
        mealConfigs: [{ orderType: 'DYNAMIC', isActive: true, mealType: 'LUNCH' }],
      },
    ],
  }
}

function makeCtx(opts: { chatId: number; text?: string; attachments?: Attachment[] }) {
  return {
    chatId: opts.chatId,
    message: {
      body: {
        text: opts.text ?? '',
        attachments: opts.attachments ?? [],
      },
      sender: { username: null },
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Среда 2026-06-03 12:00 UTC (15:00 МСК) → ближайший будущий Пн = 2026-06-08.
  vi.setSystemTime(new Date(Date.UTC(2026, 5, 3, 12, 0, 0)))

  mockPrisma.client.updateMany.mockResolvedValue({})
  mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null)
  mockPrisma.clientMealConfig.findFirst.mockResolvedValue({
    scheduleData: { daysOfWeek: [1, 2, 3, 4, 5] },
    fixedPortions: 10,
  })
  mockPrisma.order.aggregate.mockResolvedValue({ _avg: { portions: 10 } })

  mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'NON_NUMERIC', priority: 'NORMAL' })
  mockSendBotMessage.mockResolvedValue(undefined)
  mockProcessClientMessage.mockResolvedValue({ action: 'saved', reply: 'ok' })

  mockFetchAttachment.mockResolvedValue({
    base64: 'BASE64DATA',
    buffer: Buffer.from('bytes'),
    mediaType: 'image/jpeg',
  })
  mockPut.mockResolvedValue({ url: 'https://blob.example/weekly.jpg' })
  mockParse.mockResolvedValue({
    items: [{ date: '2026-06-08', portions: 10 }],
    dietaryNotes: null,
    confidence: 0.99,
    reason: 'clear',
  })
  mockRunSanity.mockReturnValue({ ok: true, failures: [] })
  mockProcessWeekly.mockResolvedValue({
    submissionId: 'sub_1',
    status: 'AUTO_CONFIRMED',
    createdOrderIds: ['ord_1'],
  })
  mockNotifyManager.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WEEKLY routing in handleMessage', () => {
  it('WEEKLY + фото → fetch → parser(photo) → process → notify + reply', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    const ctx = makeCtx({
      chatId: 777,
      attachments: [{ type: 'image', payload: { url: 'https://max.example/photo.jpg' } }],
    })

    await handleMessage(ctx)

    expect(mockFetchAttachment).toHaveBeenCalledWith('https://max.example/photo.jpg')
    expect(mockPut).toHaveBeenCalledTimes(1)
    expect(mockParse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'photo', base64: 'BASE64DATA', mediaType: 'image/jpeg' }),
      expect.objectContaining({ clientName: 'Недельный Клиент' })
    )
    expect(mockProcessWeekly).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client_w', source: 'PHOTO', blobUrl: 'https://blob.example/weekly.jpg' })
    )
    expect(mockNotifyManager).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 'sub_1', status: 'AUTO_CONFIRMED' })
    )
    expect(mockSendBotMessage).toHaveBeenCalledWith('777', 'Получили заявку, передал менеджеру')
    // Не уходит в обычный поток.
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  it('WEEKLY + текст → parser(text) → process → notify + reply (без blob)', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockProcessWeekly.mockResolvedValue({
      submissionId: 'sub_2',
      status: 'NEEDS_REVIEW',
      createdOrderIds: [],
    })
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10, Вт 12, Ср 8' })

    await handleMessage(ctx)

    expect(mockFetchAttachment).not.toHaveBeenCalled()
    expect(mockPut).not.toHaveBeenCalled()
    expect(mockParse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', text: 'Пн 10, Вт 12, Ср 8' }),
      expect.objectContaining({ clientName: 'Недельный Клиент' })
    )
    expect(mockProcessWeekly).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'TEXT', rawText: 'Пн 10, Вт 12, Ср 8' })
    )
    expect(mockNotifyManager).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'NEEDS_REVIEW' })
    )
    // NEEDS_REVIEW → «Получили, обрабатываем».
    expect(mockSendBotMessage).toHaveBeenCalledWith('777', 'Получили, обрабатываем')
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  // F1: dup-guard блокирует ЛЮБОЙ не-CANCELLED статус. Мок findFirst эмулирует
  // БД: возвращает строку только если её статус НЕ входит в where.status.notIn.
  function simulateExistingSubmission(status: string) {
    mockPrisma.weeklyOrderSubmission.findFirst.mockImplementation(async (args: unknown) => {
      const notIn: string[] =
        (args as { where?: { status?: { notIn?: string[] } } })?.where?.status?.notIn ?? []
      return notIn.includes(status) ? null : { id: 'existing_sub', status }
    })
  }

  it('WEEKLY + дубль недели (PARSED) → InboxItem, парсер НЕ вызывается', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    simulateExistingSubmission('PARSED')
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10' })

    await handleMessage(ctx)

    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'NON_NUMERIC' })
    )
    const humanReason = mockCreateInbox.mock.calls[0][0].humanReason
    expect(humanReason).toContain('Дубль заявки на неделю')
    expect(humanReason).toContain('PARSED')
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockProcessWeekly).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith(
      '777',
      'У нас уже есть ваша заявка на эту неделю. Менеджер проверит и свяжется с вами.'
    )
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  it('F1: дубль в статусе NEEDS_REVIEW → guard срабатывает, LLM НЕ вызывается', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    simulateExistingSubmission('NEEDS_REVIEW')
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10' })

    await handleMessage(ctx)

    expect(mockParse).not.toHaveBeenCalled()
    expect(mockProcessWeekly).not.toHaveBeenCalled()
    expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('NEEDS_REVIEW')
    expect(mockSendBotMessage).toHaveBeenCalledWith(
      '777',
      'У нас уже есть ваша заявка на эту неделю. Менеджер проверит и свяжется с вами.'
    )
  })

  it('F1: дубль в статусе FAILED → guard срабатывает, LLM НЕ вызывается', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    simulateExistingSubmission('FAILED')
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10' })

    await handleMessage(ctx)

    expect(mockParse).not.toHaveBeenCalled()
    expect(mockProcessWeekly).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith(
      '777',
      'У нас уже есть ваша заявка на эту неделю. Менеджер проверит и свяжется с вами.'
    )
  })

  it('F1: прошлая заявка CANCELLED → guard НЕ срабатывает, нормальный flow с LLM', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    simulateExistingSubmission('CANCELLED')
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10' })

    await handleMessage(ctx)

    // CANCELLED не блокирует → парсер вызывается, заявка обрабатывается заново.
    expect(mockParse).toHaveBeenCalledTimes(1)
    expect(mockProcessWeekly).toHaveBeenCalledTimes(1)
  })

  it('WEEKLY + не-image вложение → InboxItem, парсер НЕ вызывается', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    const ctx = makeCtx({
      chatId: 777,
      attachments: [{ type: 'file', payload: { url: 'https://max.example/doc.pdf' } }],
    })

    await handleMessage(ctx)

    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'NON_NUMERIC' })
    )
    expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('не-image')
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockProcessWeekly).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith('777', 'Получили файл, обрабатываем…')
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  it('не-WEEKLY → weekly-хелперы НЕ вызываются, идёт processClientMessage', async () => {
    mockFindClient.mockResolvedValue(makePlainClient())
    const ctx = makeCtx({ chatId: 888, text: '10' })

    await handleMessage(ctx)

    expect(mockParse).not.toHaveBeenCalled()
    expect(mockProcessWeekly).not.toHaveBeenCalled()
    expect(mockNotifyManager).not.toHaveBeenCalled()
    expect(mockProcessClientMessage).toHaveBeenCalledWith({ maxChatId: '888', text: '10' })
  })
})
