import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma, mockNextDay, mockSend, mockChatId } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findMany: vi.fn() },
    botConversation: { findFirst: vi.fn(), create: vi.fn() },
    botMessage: { create: vi.fn() },
    order: { findMany: vi.fn() },
    clientMealConfig: { findMany: vi.fn() },
  },
  mockNextDay: vi.fn(),
  mockSend: vi.fn(),
  mockChatId: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/db/queries/bot', () => ({ getNextActiveDayForClient: mockNextDay }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSend }))
vi.mock('@/lib/bot/max-users', () => ({ getActiveMaxChatIdForClient: mockChatId }))

import {
  runDailyQuestions,
  allKeysSettled,
  isDeliveryDateAnswered,
  buildCandidatesWhere,
  type RunDailyQuestionsOptions,
} from './daily-questions-core'

const TODAY = new Date('2026-06-08T00:00:00.000Z') // пн
const TOMORROW = new Date('2026-06-09T00:00:00.000Z')

const opts: RunDailyQuestionsOptions = {
  label: 'daily-questions',
  todayMsk: TODAY,
  targetMode: 'next-active',
  searchFrom: TOMORROW,
  where: buildCandidatesWhere(false),
  dryRun: false,
}

const nextDay = (keys: Array<{ locationId: string; mealType: string }>) => ({
  date: TOMORROW,
  configs: keys.map((k, i) => ({
    configId: `cfg${i}`,
    clientId: 'c1',
    clientName: 'Кафе',
    locationId: k.locationId,
    mealType: k.mealType,
    fixedPortions: null,
  })),
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.client.findMany.mockResolvedValue([{ id: 'c1', name: 'Кафе', locations: [] }])
  mockChatId.mockResolvedValue('chat1')
  mockNextDay.mockResolvedValue(nextDay([{ locationId: 'l1', mealType: 'LUNCH' }]))
  mockPrisma.botConversation.findFirst.mockResolvedValue(null)
  mockPrisma.botConversation.create.mockResolvedValue({ id: 'conv_new' })
  mockPrisma.botMessage.create.mockResolvedValue({})
  mockPrisma.order.findMany.mockResolvedValue([])
  mockSend.mockResolvedValue(undefined)
})

describe('allKeysSettled', () => {
  const key = { locationId: 'l1', mealType: 'LUNCH' as const }
  it('CONFIRMED с числом > 0 → ответ есть', () => {
    expect(allKeysSettled([key], [{ ...key, portions: 7, status: 'CONFIRMED' }])).toBe(true)
  })
  it('PENDING-заглушка 0 → ответа нет', () => {
    expect(allKeysSettled([key], [{ ...key, portions: 0, status: 'PENDING_CONFIRMATION' }])).toBe(false)
  })
  it('LOCKED дальше по конвейеру → ответ есть', () => {
    expect(allKeysSettled([key], [{ ...key, portions: 5, status: 'LOCKED' }])).toBe(true)
  })
  it('из двух приёмов отвечен один → спрашиваем', () => {
    const dinner = { locationId: 'l1', mealType: 'DINNER' as const }
    expect(allKeysSettled([key, dinner], [{ ...key, portions: 7, status: 'CONFIRMED' }])).toBe(false)
  })
  it('пустой список ключей → спрашиваем', () => {
    expect(allKeysSettled([], [])).toBe(false)
  })
})

describe('runDailyQuestions — уже ответил на целевую дату', () => {
  it('«на завтра 7» утром / менеджер поставил число → вопрос не шлём, conv не создаём', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', portions: 7, status: 'CONFIRMED' },
    ])

    const r = await runDailyQuestions(opts)

    expect(r.sent).toBe(0)
    expect(r.skipped_already_answered).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
    // Нет PENDING-conv → напоминания 14:00/15:30 и cutoff 16:00 клиента не тронут.
    expect(mockPrisma.botConversation.create).not.toHaveBeenCalled()
    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.clientId).toBe('c1')
    expect(where.deliveryDate).toEqual(TOMORROW)
  })

  it('отвечен только обед, ужин нет → спрашиваем', async () => {
    mockNextDay.mockResolvedValue(
      nextDay([
        { locationId: 'l1', mealType: 'LUNCH' },
        { locationId: 'l1', mealType: 'DINNER' },
      ]),
    )
    mockPrisma.order.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', portions: 7, status: 'CONFIRMED' },
    ])

    const r = await runDailyQuestions(opts)

    expect(r.sent).toBe(1)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})

describe('runDailyQuestions — повтор после сбоя отправки', () => {
  it('send упал → conv осталась без сообщений → повторный прогон шлёт в ту же conv', async () => {
    // 1-й прогон: conv создана, отправка падает.
    mockSend.mockRejectedValueOnce(new Error('MAX 502'))
    const r1 = await runDailyQuestions(opts)
    expect(r1.sent).toBe(0)
    expect(r1.errors).toHaveLength(1)
    expect(mockPrisma.botMessage.create).not.toHaveBeenCalled()

    // 2-й прогон: conv есть, PENDING, ни одного сообщения.
    mockPrisma.botConversation.findFirst.mockResolvedValue({
      id: 'conv_new',
      status: 'PENDING',
      messages: [],
    })
    mockPrisma.botConversation.create.mockClear()
    const r2 = await runDailyQuestions(opts)

    expect(r2.sent).toBe(1)
    expect(r2.resent_unsent).toBe(1)
    expect(mockPrisma.botConversation.create).not.toHaveBeenCalled()
    expect(mockPrisma.botMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: 'conv_new', direction: 'OUT' }),
      }),
    )
  })

  it('conv с сообщениями (вопрос ушёл / клиент писал) → skipped_existing', async () => {
    mockPrisma.botConversation.findFirst.mockResolvedValue({
      id: 'conv1',
      status: 'PENDING',
      messages: [{ id: 'm1' }],
    })
    const r = await runDailyQuestions(opts)
    expect(r.skipped_existing).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('conv без сообщений, но не PENDING (менеджер/закрыта) → не трогаем', async () => {
    mockPrisma.botConversation.findFirst.mockResolvedValue({
      id: 'conv1',
      status: 'AWAITING_MANAGER',
      messages: [],
    })
    const r = await runDailyQuestions(opts)
    expect(r.skipped_existing).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('isDeliveryDateAnswered без готовых ключей', () => {
  it('грузит DYNAMIC-конфиги клиента на активных точках и проверяет заказы', async () => {
    mockPrisma.clientMealConfig.findMany.mockResolvedValue([
      {
        locationId: 'l1',
        mealType: 'LUNCH',
        scheduleType: 'DAILY',
        scheduleData: null,
        validFrom: null,
        validTo: null,
      },
    ])
    mockPrisma.order.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', portions: 3, status: 'CONFIRMED' },
    ])
    expect(await isDeliveryDateAnswered('c1', TOMORROW)).toBe(true)
    const where = mockPrisma.clientMealConfig.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ clientId: 'c1', orderType: 'DYNAMIC', isActive: true, location: { isActive: true } })
  })
})
