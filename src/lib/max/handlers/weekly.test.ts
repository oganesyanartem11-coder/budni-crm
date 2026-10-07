import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * MEGA wiring (Subagent C): маршрутизация WEEKLY-заявок в MAX-вебхуке.
 *
 * Проверяем handleMessage (surgical edit) + weekly-хелперы целиком:
 *  - WEEKLY + фото → fetch → parser('photo') → process → «внесено» менеджеру + ответ клиенту;
 *  - WEEKLY + текст на проверку → кнопки менеджеру + «менеджер проверит»;
 *  - повторная заявка на ту же неделю обрабатывается заново (upsert, без дубль-гарда);
 *  - ошибка обработки не глотается: inbox + личка ADMIN_PRO;
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
  mockProcessWeekly,
  mockNotifyApplied,
  mockNotifyReview,
  mockNotifyAdminPro,
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
  mockProcessWeekly: vi.fn(),
  mockNotifyApplied: vi.fn(),
  mockNotifyReview: vi.fn(),
  mockNotifyAdminPro: vi.fn(),
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
vi.mock('@/lib/weekly/actions', () => ({
  processWeeklySubmission: mockProcessWeekly,
  loadWeeklyConfigOptions: vi.fn(async () => [
    { configId: 'cfg_1', locationId: 'loc_1', locationName: 'Офис' },
  ]),
  loadUpcomingWeeklyOrders: vi.fn(async () => ({
    list: [{ date: '2026-06-09', locationId: 'loc_1', locationName: 'Офис', portions: 34 }],
    byKey: new Map(),
  })),
}))
vi.mock('@/lib/telegram/handlers/weekly-submission', () => ({
  notifyManagersWeeklyApplied: mockNotifyApplied,
  notifyManagersWeeklyReview: mockNotifyReview,
  formatClientAppliedReply: () => 'Принято! Внесли заявку: пн 8 июн — 10.',
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyAllAdminProDirect: mockNotifyAdminPro,
  escapeHtml: (s: string) => s,
}))
// Не нужны в этих тестах, но импортируются handlers.ts транзитивно.
vi.mock('@/lib/bot/log-message', () => ({ logBotMessage: vi.fn() }))
vi.mock('@/lib/bot/notify-client-signal', () => ({ notifyClientSignal: vi.fn(async () => {}) }))
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
  // Среда 2026-06-03 12:00 UTC (15:00 МСК).
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
  mockProcessWeekly.mockResolvedValue({
    submissionId: 'sub_1',
    status: 'AUTO_CONFIRMED',
    lines: [],
    reviewReasons: [],
    applied: {
      applyLogId: 'log_1',
      outcomes: [{ date: '2026-06-08', locationName: 'Офис', portions: 10, result: 'created', note: null }],
      menuMissingDates: [],
    },
  })
  mockNotifyApplied.mockResolvedValue(undefined)
  mockNotifyReview.mockResolvedValue(undefined)
  mockNotifyAdminPro.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WEEKLY routing in handleMessage', () => {
  it('WEEKLY + фото, чистая заявка → внесено: менеджеру итог, клиенту список', async () => {
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
      expect.objectContaining({
        clientName: 'Недельный Клиент',
        locations: [{ id: 'loc_1', name: 'Офис' }],
      })
    )
    expect(mockProcessWeekly).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client_w', source: 'PHOTO', blobUrl: 'https://blob.example/weekly.jpg' })
    )
    expect(mockNotifyApplied).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 'sub_1', clientName: 'Недельный Клиент' })
    )
    expect(mockNotifyReview).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith('777', 'Принято! Внесли заявку: пн 8 июн — 10.')
    // Не уходит в обычный поток.
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  it('WEEKLY + текст на ручную проверку → кнопки менеджеру, клиенту «менеджер проверит»', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockProcessWeekly.mockResolvedValue({
      submissionId: 'sub_2',
      status: 'NEEDS_REVIEW',
      lines: [],
      reviewReasons: ['уверенность распознавания 0.70 ниже 0.8'],
      applied: null,
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
    expect(mockNotifyReview).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionId: 'sub_2',
        reviewReasons: ['уверенность распознавания 0.70 ниже 0.8'],
      })
    )
    expect(mockSendBotMessage).toHaveBeenCalledWith(
      '777',
      'Спасибо, заявку получили, менеджер проверит и подтвердит.'
    )
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
  })

  it('повторная заявка на ту же неделю обрабатывается заново (без дубль-гарда)', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue({ id: 'existing', status: 'AUTO_CONFIRMED' })
    const ctx = makeCtx({ chatId: 777, text: 'Пн 12' })

    await handleMessage(ctx)

    expect(mockParse).toHaveBeenCalledTimes(1)
    expect(mockProcessWeekly).toHaveBeenCalledTimes(1)
    expect(mockCreateInbox).not.toHaveBeenCalled()
  })

  it('сообщение без заявки («спасибо») → inbox, без ответа клиенту и без уведомлений о заявке', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockProcessWeekly.mockResolvedValue({
      submissionId: null,
      status: 'NOT_A_SUBMISSION',
      lines: [],
      reviewReasons: [],
      applied: null,
    })
    const ctx = makeCtx({ chatId: 777, text: 'спасибо!' })

    await handleMessage(ctx)

    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ humanReason: 'Сообщение недельного клиента без заявки' })
    )
    expect(mockNotifyApplied).not.toHaveBeenCalled()
    expect(mockNotifyReview).not.toHaveBeenCalled()
    expect(mockSendBotMessage).not.toHaveBeenCalled()
  })

  it('сбой уведомления ПОСЛЕ внесения не превращается в «заявка не обработана»', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockNotifyApplied.mockRejectedValue(new Error('tg down'))
    const ctx = makeCtx({ chatId: 777, text: 'Пн 10' })

    await handleMessage(ctx)

    expect(mockNotifyAdminPro).not.toHaveBeenCalled()
    expect(mockCreateInbox).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith('777', 'Принято! Внесли заявку: пн 8 июн — 10.')
  })

  it('ошибка обработки не глотается: inbox HIGH + личка ADMIN_PRO', async () => {
    mockFindClient.mockResolvedValue(makeWeeklyClient())
    mockProcessWeekly.mockRejectedValue(new Error('db down'))
    const ctx = makeCtx({ chatId: 777, text: 'Пн 12' })

    await handleMessage(ctx)

    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client_w', priority: 'HIGH' })
    )
    expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('db down')
    expect(mockNotifyAdminPro).toHaveBeenCalledWith(expect.stringContaining('недельная заявка не обработана'))
    expect(mockProcessClientMessage).not.toHaveBeenCalled()
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
    expect(mockNotifyApplied).not.toHaveBeenCalled()
    expect(mockProcessClientMessage).toHaveBeenCalledWith({ maxChatId: '888', text: '10' })
  })
})
