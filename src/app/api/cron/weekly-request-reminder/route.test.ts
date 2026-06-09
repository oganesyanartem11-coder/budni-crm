import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * weekly-request-reminder cron: напоминание WEEKLY-клиентам без заявки на
 * след. неделю. Мокаем prisma (client.findMany / weeklyOrderSubmission.findFirst /
 * activityLog для idempotency-гарда) и sendBotMessage. Дёргаем handler напрямую
 * (минуя withCronHeartbeat auth) — поведение не меняем, GET по-прежнему
 * собирается через withCronHeartbeat.
 */

const { mockPrisma, mockSendBotMessage, mockGetActiveChatId } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findMany: vi.fn() },
    weeklyOrderSubmission: { findFirst: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn() },
  },
  mockSendBotMessage: vi.fn(),
  mockGetActiveChatId: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBotMessage }))
// 7.55: прод резолвит chatId активного пользователя через getActiveMaxChatIdForClient,
// а не через client.maxChatId. Дефолт — '12345' (как у фикстур, где раньше слали);
// кейс «без привязки» переопределяет на null через mockResolvedValueOnce.
vi.mock('@/lib/bot/max-users', () => ({
  getActiveMaxChatIdForClient: mockGetActiveChatId,
}))

import { handler } from './route'

const WEEKLY_REMINDER_TO_CLIENT = `Здравствуйте! На следующую неделю ещё не получили заявку. Если уже знаете количество — пришлите фото или текст со списком дней и порций. Ждём до воскресенья.

— Будни`

const REQ = new Request('http://x/api/cron/weekly-request-reminder')

beforeEach(() => {
  vi.clearAllMocks()
  // idempotency: ещё не запускался сегодня; markRanToday.create — no-op.
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'log_1' })
  mockSendBotMessage.mockResolvedValue(undefined)
  // По умолчанию у клиента есть активный пользователь с chatId '12345'
  // (совпадает с прежними фикстурами maxChatId, где сообщение слалось).
  mockGetActiveChatId.mockResolvedValue('12345')
})

describe('weekly-request-reminder', () => {
  it('клиент без заявки на след. неделю → шлём verbatim-напоминание один раз', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'Клиент 1', maxChatId: '12345' },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null) // нет заявки

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockSendBotMessage).toHaveBeenCalledTimes(1)
    expect(mockSendBotMessage).toHaveBeenCalledWith('12345', WEEKLY_REMINDER_TO_CLIENT, {
      delay: true,
    })
    expect(body.sent).toBe(1)
  })

  it('клиент С заявкой на след. неделю → sendBotMessage НЕ вызывается', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'Клиент 1', maxChatId: '12345' },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue({ id: 'sub_1' }) // есть заявка

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body.sent).toBe(0)
    expect(body.skippedHasSubmission).toBe(1)
  })

  it('клиент без активного пользователя → не шлём, считаем skippedNoChat', async () => {
    mockPrisma.client.findMany.mockResolvedValue([
      { id: 'c1', name: 'Клиент 1', maxChatId: null },
    ])
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null)
    // 7.55: нет активного пользователя → getActiveMaxChatIdForClient вернул null → скип.
    mockGetActiveChatId.mockResolvedValue(null)

    const res = await handler(REQ)
    const body = await res.json()

    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body.skippedNoChat).toBe(1)
  })

  it('idempotency: уже запускался сегодня → skip без рассылки', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'ran' })

    const res = await handler(REQ)
    const body = await res.json()

    expect(body.skipped).toBe(true)
    expect(mockPrisma.client.findMany).not.toHaveBeenCalled()
    expect(mockSendBotMessage).not.toHaveBeenCalled()
  })
})
