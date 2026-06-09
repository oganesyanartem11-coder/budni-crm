import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * MEGA-3 (П11): guard ручной переписки менеджера.
 *
 * Если менеджер писал клиенту вручную (BotMessage.direction='MANAGER_OUT')
 * за последние 30 минут — бот НЕ автоотвечает. Только фиксирует входящее и
 * заводит/обновляет InboxItem. Если последний MANAGER_OUT старше 30 минут —
 * автоответ как обычно.
 *
 * Время мокаем (vi.setSystemTime), возраст MANAGER_OUT задаём через мок
 * prisma.botMessage.findFirst. Реального времени не касаемся.
 */

const {
  mockPrisma,
  mockFindClient,
  mockFindConv,
  mockParse,
  mockSave,
  mockDetectAnomalies,
  mockDetectPortionAnomaly,
  mockGetStats,
  mockSendBotMessage,
  mockLogBotMessage,
  mockClassifyTone,
  mockCreateInbox,
  mockNotifySignal,
} = vi.hoisted(() => ({
  mockPrisma: {
    user: { findMany: vi.fn() },
    client: { update: vi.fn(), findUnique: vi.fn() },
    botConversation: { update: vi.fn(), findFirst: vi.fn() },
    inboxItem: { findFirst: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn() },
    botMessage: { findFirst: vi.fn() },
    clientMaxUser: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async () => []),
  },
  mockFindClient: vi.fn(),
  mockFindConv: vi.fn(),
  mockParse: vi.fn(),
  mockSave: vi.fn(),
  mockDetectAnomalies: vi.fn(),
  mockDetectPortionAnomaly: vi.fn(),
  mockGetStats: vi.fn(),
  mockSendBotMessage: vi.fn(),
  mockLogBotMessage: vi.fn(),
  mockClassifyTone: vi.fn(),
  mockCreateInbox: vi.fn(),
  mockNotifySignal: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/db/queries/bot', () => ({
  findLatestBotConv: mockFindConv,
}))
vi.mock('@/lib/bot/max-users', () => ({
  resolveClientByChatId: mockFindClient,
  getActiveMaxChatIdForClient: vi.fn(async () => '999'),
  promoteToActiveByChatId: vi.fn(async () => {}),
}))
vi.mock('@/lib/llm/parser', () => ({ parseClientResponse: mockParse }))
vi.mock('./save-orders', () => ({ saveBotOrders: mockSave }))
vi.mock('@/lib/orders/anomaly-detector', () => ({
  detectAnomalies: mockDetectAnomalies,
  detectPortionAnomaly: mockDetectPortionAnomaly,
}))
vi.mock('@/lib/orders/client-stats', () => ({ getClientStats: mockGetStats }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSendBotMessage }))
vi.mock('./log-message', () => ({ logBotMessage: mockLogBotMessage }))
vi.mock('@/lib/llm/tone-classifier', () => ({ classifyMessageTone: mockClassifyTone }))
vi.mock('./create-inbox-item', () => ({ createInboxItem: mockCreateInbox }))
vi.mock('./notify-client-signal', () => ({ notifyClientSignal: mockNotifySignal }))
vi.mock('@/lib/boris/team-channels', () => ({
  logBorisEvent: vi.fn().mockResolvedValue(null),
  emitLivePost: vi.fn().mockResolvedValue(undefined),
  emitAlertPost: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))

import { processClientMessage } from './process-message'

function mskMidnightUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
}

function makeClient() {
  return {
    id: 'client_1',
    name: 'Тест Клиент',
    isActive: true,
    maxChatId: 'max_1',
    safeAnswerStreak: 99,
    locationAliases: {},
    locations: [
      {
        id: 'loc_1',
        name: 'Офис',
        isActive: true,
        sameDayDelivery: false,
        cutoffHourMsk: null,
        cutoffMinuteMsk: null,
        mealConfigs: [{ mealType: 'LUNCH', pricePerPortion: '300', isActive: true }],
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Фиксируем «сейчас» — 15:00 МСК = 12:00 UTC, до cut-off (чтобы при отсутствии
  // takeover ожидался обычный saved-ответ).
  vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 0, 0)))

  mockFindClient.mockResolvedValue(makeClient())
  mockFindConv.mockResolvedValue({
    id: 'conv_1',
    status: 'PENDING',
    deliveryDate: mskMidnightUtc(2026, 6, 5),
  })
  mockClassifyTone.mockResolvedValue('neutral')
  mockGetStats.mockResolvedValue({
    recentOrders: [],
    averageByDayOfWeek: {},
    typicalRange: null,
    sampleSize: 0,
  })
  mockParse.mockResolvedValue({
    type: 'numeric',
    confidence: 0.99,
    reason: null,
    toneLabel: 'neutral',
    items: [{ locationId: 'loc_1', portions: 10 }],
  })
  mockDetectAnomalies.mockReturnValue({ isAnomaly: false, priority: 'NORMAL' })
  mockDetectPortionAnomaly.mockResolvedValue({ isAnomaly: false, reason: 'no_history' })
  mockSave.mockResolvedValue({
    savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 10 }],
  })
  mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'NON_NUMERIC', priority: 'NORMAL' })
  mockNotifySignal.mockResolvedValue(undefined)
  mockLogBotMessage.mockResolvedValue(undefined)
  mockSendBotMessage.mockResolvedValue(undefined)
  mockPrisma.client.update.mockResolvedValue({})
  mockPrisma.botConversation.update.mockResolvedValue({})
  mockPrisma.botConversation.findFirst.mockResolvedValue({ id: 'conv_1' })
  mockPrisma.inboxItem.findFirst.mockResolvedValue(null)
  mockPrisma.order.findFirst.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('manager-takeover guard (П11)', () => {
  it('MANAGER_OUT за 5 минут → автоответ НЕ формируется, идём в inbox', async () => {
    const now = Date.now()
    mockPrisma.botMessage.findFirst.mockResolvedValue({
      createdAt: new Date(now - 5 * 60_000),
    })

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('inbox')
    expect(res.reply).toBeNull()
    // Клиенту НЕ отправляли автоответ.
    expect(mockSendBotMessage).not.toHaveBeenCalled()
    // Парсер заказа НЕ вызывался (рано вышли).
    expect(mockParse).not.toHaveBeenCalled()
    // Входящее зафиксировано.
    expect(mockLogBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'IN', text: '10' })
    )
  })

  it('MANAGER_OUT за 60 минут → автоответ формируется как обычно', async () => {
    const now = Date.now()
    mockPrisma.botMessage.findFirst.mockResolvedValue({
      createdAt: new Date(now - 60 * 60_000),
    })

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('saved')
    expect(res.reply).toContain('Принято')
    expect(mockSendBotMessage).toHaveBeenCalled()
  })

  it('нет MANAGER_OUT → автоответ формируется', async () => {
    mockPrisma.botMessage.findFirst.mockResolvedValue(null)

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('saved')
    expect(mockSendBotMessage).toHaveBeenCalled()
  })
})
