import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * weekly-request-reminder cron: пт 10:00 и 13:00 МСК напоминаем WEEKLY-клиентам
 * без заявки на следующую неделю. Мокаем prisma (client.findMany /
 * weeklyOrderSubmission.findFirst / order.findFirst / activityLog для
 * idempotency-гарда) и sendBotMessage. Дёргаем handler напрямую.
 */

const { mockPrisma, mockSendBotMessage, mockGetActiveChatId } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findMany: vi.fn() },
    weeklyOrderSubmission: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    activityLog: { findFirst: vi.fn(), create: vi.fn() },
  },
  mockSendBotMessage: vi.fn(),
  mockGetActiveChatId: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBotMessage }))
vi.mock('@/lib/bot/max-users', () => ({
  getActiveMaxChatIdForClient: mockGetActiveChatId,
}))

import { handler } from './route'

const REQ = new Request('http://x/api/cron/weekly-request-reminder')
// Пт 9 окт 2026: 10:00 МСК = 07:00Z, 13:00 МСК = 10:00Z.
const FRI_10 = new Date('2026-10-09T07:00:00.000Z')
const FRI_13 = new Date('2026-10-09T10:00:00.000Z')

const CLIENT = { id: 'c1', name: 'ИНПАРТ', mealConfigs: [{ locationId: 'loc_1', mealType: 'LUNCH' }] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(FRI_10)
  mockPrisma.activityLog.findFirst.mockResolvedValue(null)
  mockPrisma.activityLog.create.mockResolvedValue({ id: 'log_1' })
  mockPrisma.client.findMany.mockResolvedValue([CLIENT])
  mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue(null)
  mockPrisma.order.findFirst.mockResolvedValue(null)
  mockSendBotMessage.mockResolvedValue(undefined)
  mockGetActiveChatId.mockResolvedValue('12345')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('weekly-request-reminder (пт 10:00 и 13:00)', () => {
  it('10:00: клиент без заявки → «Ждём заявку на следующую неделю (12.10–18.10)»', async () => {
    const body = await (await handler(REQ)).json()

    expect(mockSendBotMessage).toHaveBeenCalledWith(
      '12345',
      'Здравствуйте! Ждём заявку на следующую неделю (12.10–18.10). Пришлите, пожалуйста, фото или текст: дни и количество порций.\n\n— Будни',
      { delay: false },
    )
    expect(body).toMatchObject({ slot: 'morning', sent: 1, weekStartDate: '2026-10-12T00:00:00.000Z' })
    // своя метка идемпотентности на слот
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data.entityId).toBe('weekly-request-reminder:morning')
  })

  it('13:00: не ответил → повторное напоминание другим текстом, утренний запуск ему не мешает', async () => {
    vi.setSystemTime(FRI_13)
    mockPrisma.activityLog.findFirst.mockImplementation(async ({ where }: { where: { entityId: string } }) =>
      where.entityId === 'weekly-request-reminder:morning' ? { id: 'ran_morning' } : null,
    )

    const body = await (await handler(REQ)).json()

    expect(body.slot).toBe('afternoon')
    expect(mockSendBotMessage.mock.calls[0][1]).toContain('Напоминаем: заявку на следующую неделю (12.10–18.10) ещё не получили')
  })

  it('заявка на следующую неделю уже есть → не пишем', async () => {
    mockPrisma.weeklyOrderSubmission.findFirst.mockResolvedValue({ id: 'sub_1' })
    const body = await (await handler(REQ)).json()
    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body.skippedHasSubmission).toBe(1)
  })

  it('заявки нет, но заказы на следующую неделю уже внесены → не пишем', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1' })
    const body = await (await handler(REQ)).json()
    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body.skippedHasSubmission).toBe(1)
    expect(mockPrisma.order.findFirst.mock.calls[0][0].where).toMatchObject({
      clientId: 'c1',
      deliveryDate: { gte: new Date('2026-10-12T00:00:00.000Z'), lt: new Date('2026-10-19T00:00:00.000Z') },
      status: { not: 'CANCELLED' },
      portions: { gt: 0 },
    })
  })

  it('клиент без активного пользователя → не шлём, считаем skippedNoChat', async () => {
    mockGetActiveChatId.mockResolvedValue(null)
    const body = await (await handler(REQ)).json()
    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(body.skippedNoChat).toBe(1)
  })

  it('idempotency: этот слот уже был сегодня → skip без рассылки', async () => {
    mockPrisma.activityLog.findFirst.mockResolvedValue({ id: 'ran' })
    const body = await (await handler(REQ)).json()
    expect(body.skipped).toBe(true)
    expect(mockPrisma.client.findMany).not.toHaveBeenCalled()
  })
})
