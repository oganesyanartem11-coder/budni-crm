import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * MEGA-3 (П5+П9): cut-off в МСК и same-day cut-off в ответах бота.
 *
 * Проверяем именно ВЕТВЛЕНИЕ reply (нормальный приём vs post-cutoff) в
 * handleBotResponse через публичный processClientMessage. Время мокаем через
 * vi.setSystemTime (внутри хендлера now = new Date()), НЕ зависим от реального.
 *
 * Все тяжёлые коллабораторы (БД, MAX-send, LLM-парсер, tone, boris-team,
 * notify) замоканы — тест изолирует только логику cut-off/ответа.
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
  findClientByMaxChatId: mockFindClient,
  findLatestBotConv: mockFindConv,
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

// deliveryDate в проде = UTC-полночь МСК-календарной даты (Date.UTC(y,m,d)).
function mskMidnightUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
}

function makeClient(opts: { sameDay?: boolean; cutoffHour?: number; cutoffMinute?: number } = {}) {
  return {
    id: 'client_1',
    name: 'Тест Клиент',
    isActive: true,
    maxChatId: 'max_1',
    safeAnswerStreak: 99, // не новый клиент
    locationAliases: {},
    locations: [
      {
        id: 'loc_1',
        name: 'Офис',
        isActive: true,
        sameDayDelivery: opts.sameDay ?? false,
        cutoffHourMsk: opts.cutoffHour ?? null,
        cutoffMinuteMsk: opts.cutoffMinute ?? null,
        mealConfigs: [{ mealType: 'LUNCH', pricePerPortion: '300', isActive: true }],
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()

  mockClassifyTone.mockResolvedValue('neutral')
  mockGetStats.mockResolvedValue({
    recentOrders: [],
    averageByDayOfWeek: {},
    typicalRange: null,
    sampleSize: 0,
  })
  // Числовой ответ, без аномалий → ветка saved/post-cutoff.
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
  mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'POST_CUTOFF', priority: 'NORMAL' })
  mockNotifySignal.mockResolvedValue(undefined)
  mockLogBotMessage.mockResolvedValue(undefined)
  mockSendBotMessage.mockResolvedValue(undefined)
  mockPrisma.client.update.mockResolvedValue({})
  mockPrisma.botConversation.update.mockResolvedValue({})
  mockPrisma.order.findFirst.mockResolvedValue(null)
  // П11: по умолчанию менеджер НЕ в ручной переписке.
  mockPrisma.botMessage.findFirst.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('process-message cut-off (П5/П9)', () => {
  it('pre-cutoff 15:48 МСК (обычный клиент) → НЕ post-cutoff, нормальный приём', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    // conv PENDING, доставка завтра
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    // 15:48 МСК = 12:48 UTC
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('saved')
    expect(res.reply).toContain('Принято')
    expect(res.reply).not.toMatch(/сложнее/i)
  })

  it('post-cutoff 16:30 МСК (обычный клиент) → post-cutoff ответ', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    // 16:30 МСК = 13:30 UTC
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 13, 30, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('post_cutoff')
    expect(res.reply).toMatch(/сложнее/i)
    expect(res.reply).toContain('16:00')
  })

  it('SAME-DAY клиент (cut-off 08:40) в 09:00 МСК → post-cutoff с упоминанием 08:40, НЕ 16:00', async () => {
    mockFindClient.mockResolvedValue(
      makeClient({ sameDay: true, cutoffHour: 8, cutoffMinute: 40 })
    )
    // доставка СЕГОДНЯ
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 4),
    })
    // 09:00 МСК = 06:00 UTC (после 08:40)
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 6, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('post_cutoff')
    expect(res.reply).toContain('08:40')
    expect(res.reply).not.toContain('16:00')
  })

  it('SAME-DAY клиент (cut-off 08:40) в 08:00 МСК → нормальный приём (до cut-off)', async () => {
    mockFindClient.mockResolvedValue(
      makeClient({ sameDay: true, cutoffHour: 8, cutoffMinute: 40 })
    )
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 4),
    })
    // 08:00 МСК = 05:00 UTC (до 08:40)
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 5, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('saved')
    expect(res.reply).toContain('Принято')
  })
})
