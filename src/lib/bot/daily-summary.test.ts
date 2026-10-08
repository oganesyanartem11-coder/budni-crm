import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma, mockSend, mockChatId } = vi.hoisted(() => ({
  mockPrisma: {
    botConversation: { findMany: vi.fn() },
    botMessage: { findFirst: vi.fn(), create: vi.fn() },
    client: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
    clientMealConfig: { findMany: vi.fn() },
  },
  mockSend: vi.fn(),
  mockChatId: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSend }))
vi.mock('@/lib/bot/max-users', () => ({ getActiveMaxChatIdForClient: mockChatId }))
vi.mock('@/lib/db/queries/bot', () => ({ getNextActiveDayForClient: vi.fn() }))
vi.mock('@/lib/telegram/notify', () => ({
  notifyAllManagersDirect: vi.fn(),
  escapeHtml: (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}))

import { buildSummaryText, formatOrdersBreakdown, sendRemindersToSilentClients } from './daily-summary'
import { SAME_DAY_DYNAMIC_LOCATION } from './daily-questions-core'

const NOW = new Date('2026-06-08T11:00:00.000Z') // пн 14:00 МСК
const TOMORROW = new Date('2026-06-09T00:00:00.000Z')
const TODAY = new Date('2026-06-08T00:00:00.000Z')

const loc1 = { id: 'l1', name: 'Повадино' }
const loc2 = { id: 'l2', name: 'Склад' }

function conv(over: Record<string, unknown>) {
  return {
    id: 'cv',
    clientId: 'c1',
    deliveryDate: TOMORROW,
    status: 'CONFIRMED',
    client: { id: 'c1', name: 'Идеология Еды' },
    orders: [],
    messages: [],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('formatOrdersBreakdown', () => {
  it('одна точка, три приёма → «завтрак 45 · обед 75 · ужин 45»', () => {
    expect(
      formatOrdersBreakdown([
        { portions: 75, status: 'CONFIRMED', mealType: 'LUNCH', location: loc1 },
        { portions: 45, status: 'CONFIRMED', mealType: 'DINNER', location: loc1 },
        { portions: 45, status: 'CONFIRMED', mealType: 'BREAKFAST', location: loc1 },
      ]),
    ).toBe('завтрак 45 · обед 75 · ужин 45')
  })

  it('отменённые не считаются; один приём → «N порций»', () => {
    expect(
      formatOrdersBreakdown([
        { portions: 30, status: 'CONFIRMED', mealType: 'LUNCH', location: loc1 },
        { portions: 99, status: 'CANCELLED', mealType: 'DINNER', location: loc1 },
      ]),
    ).toBe('30 порций')
  })

  it('несколько точек → разбивка по точкам', () => {
    expect(
      formatOrdersBreakdown([
        { portions: 30, status: 'CONFIRMED', mealType: 'LUNCH', location: loc1 },
        { portions: 20, status: 'CONFIRMED', mealType: 'LUNCH', location: loc2 },
        { portions: 10, status: 'CONFIRMED', mealType: 'DINNER', location: loc2 },
      ]),
    ).toBe('Повадино: обед 30; Склад: обед 20 · ужин 10')
  })
})

describe('buildSummaryText', () => {
  it('разбивка по приёмам, без отменённых, группа «У менеджера» в итоге', async () => {
    mockPrisma.botConversation.findMany.mockResolvedValue([
      conv({
        orders: [
          { portions: 45, status: 'CONFIRMED', mealType: 'BREAKFAST', location: loc1 },
          { portions: 75, status: 'CONFIRMED', mealType: 'LUNCH', location: loc1 },
          { portions: 45, status: 'CONFIRMED', mealType: 'DINNER', location: loc1 },
          { portions: 50, status: 'CANCELLED', mealType: 'LUNCH', location: loc1 },
        ],
      }),
      conv({ id: 'cv2', clientId: 'c2', status: 'PENDING', client: { id: 'c2', name: 'Молчун' } }),
      conv({ id: 'cv3', clientId: 'c3', status: 'AWAITING_MANAGER', client: { id: 'c3', name: 'A & B' } }),
    ])

    const text = (await buildSummaryText('Сводка по заявкам (14:00)', NOW))!

    expect(text).toContain('Принято: 1 из 3')
    expect(text).toContain('• Идеология Еды — завтрак 45 · обед 75 · ужин 45')
    expect(text).toContain('Не ответили: 1')
    expect(text).toContain('• Молчун')
    expect(text).toContain('У менеджера: 1')
    expect(text).toContain('• A &amp; B')
    expect(text).not.toContain('(09.06)')
  })

  it('смешаны same-day (сегодня) и завтра → у строк дата', async () => {
    mockPrisma.botConversation.findMany.mockResolvedValue([
      conv({ orders: [{ portions: 10, status: 'CONFIRMED', mealType: 'LUNCH', location: loc1 }] }),
      conv({
        id: 'cv2',
        clientId: 'c2',
        status: 'PENDING',
        deliveryDate: TODAY,
        client: { id: 'c2', name: 'Утренний' },
      }),
    ])
    const text = (await buildSummaryText('T', NOW))!
    expect(text).toContain('• Идеология Еды (09.06) — 10 порций')
    expect(text).toContain('• Утренний (08.06)')
  })

  it('нет отслеживаемых conv → null', async () => {
    mockPrisma.botConversation.findMany.mockResolvedValue([])
    expect(await buildSummaryText('T', NOW)).toBeNull()
  })
})

describe('sendRemindersToSilentClients', () => {
  beforeEach(() => {
    mockPrisma.botConversation.findMany.mockResolvedValue([conv({ status: 'PENDING' })])
    mockPrisma.client.findMany.mockResolvedValue([])
    mockChatId.mockResolvedValue('chat1')
    mockPrisma.botMessage.findFirst.mockResolvedValue(null)
    mockPrisma.botMessage.create.mockResolvedValue({})
    mockPrisma.clientMealConfig.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', scheduleType: 'DAILY', scheduleData: null, validFrom: null, validTo: null },
    ])
    mockPrisma.order.findMany.mockResolvedValue([])
  })

  it('same-day исключение — только по активной same-day точке с DYNAMIC', async () => {
    await sendRemindersToSilentClients(() => 'x', NOW)
    const where = mockPrisma.client.findMany.mock.calls[0][0].where
    expect(where.locations).toEqual({ some: SAME_DAY_DYNAMIC_LOCATION })
  })

  it('textFor получает момент отправки (для «на завтра» только если завтра)', async () => {
    const textFor = vi.fn(() => 'reminder')
    const r = await sendRemindersToSilentClients(textFor, NOW)
    expect(r.sent).toBe(1)
    expect(textFor).toHaveBeenCalledWith(TOMORROW, NOW)
  })

  it('менеджер уже поставил число после вопроса → не напоминаем', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      { locationId: 'l1', mealType: 'LUNCH', portions: 7, status: 'CONFIRMED' },
    ])
    const r = await sendRemindersToSilentClients(() => 'x', NOW)
    expect(r.sent).toBe(0)
    expect(r.skipped).toBe(1)
    expect(mockSend).not.toHaveBeenCalled()
  })
})
