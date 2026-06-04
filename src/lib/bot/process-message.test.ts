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
  mockParseChangeIntent,
  mockResolveTarget,
  mockCreatePendingChange,
  mockFindActiveOrder,
  mockNotifyManagerOrderChange,
} = vi.hoisted(() => ({
  mockPrisma: {
    user: { findMany: vi.fn() },
    client: { update: vi.fn(), findUnique: vi.fn() },
    botConversation: { update: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
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
  mockParseChangeIntent: vi.fn(),
  mockResolveTarget: vi.fn(),
  mockCreatePendingChange: vi.fn(),
  mockFindActiveOrder: vi.fn(),
  mockNotifyManagerOrderChange: vi.fn(),
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
// П3 (MEGA-4b): order-change collaborators (Subagent B/C).
vi.mock('@/lib/bot/parse-change-intent', () => ({ parseChangeIntent: mockParseChangeIntent }))
vi.mock('@/lib/order-changes/resolve-target', () => ({
  resolveOrderChangeTarget: mockResolveTarget,
}))
vi.mock('@/lib/order-changes/actions', () => ({ createPendingChange: mockCreatePendingChange }))
vi.mock('@/lib/db/queries/orders', () => ({ findActiveOrder: mockFindActiveOrder }))
vi.mock('@/lib/telegram/handlers/order-change', () => ({
  notifyManagerAboutOrderChange: mockNotifyManagerOrderChange,
}))

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

  // П3 (MEGA-4b): по умолчанию НЕ запрос на изменение → старые spontaneous-тесты
  // и весь legacy flow не задеты. Конкретные кейсы переопределяют моки локально.
  mockParseChangeIntent.mockResolvedValue({ action: 'NONE', reason: 'default' })
  mockResolveTarget.mockReturnValue({ ok: true, locationId: 'loc_1', mealType: 'LUNCH' })
  mockFindActiveOrder.mockResolvedValue(null)
  mockCreatePendingChange.mockResolvedValue({ id: 'pending_1' })
  mockNotifyManagerOrderChange.mockResolvedValue(undefined)
  // Для spontaneous-ветки: conv не найдена → create новую AWAITING_MANAGER.
  mockPrisma.botConversation.findFirst.mockResolvedValue(null)
  mockPrisma.botConversation.create.mockResolvedValue({
    id: 'conv_spont',
    status: 'AWAITING_MANAGER',
    deliveryDate: mskMidnightUtc(2026, 6, 4),
  })
  mockPrisma.inboxItem.findFirst.mockResolvedValue(null)
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

// ─────────────────────────────────────────────────────────────────────────
// П8: КЕЙС B — повтор того же заказа на уже CONFIRMED conv, без изменений.
// saveBotOrders возвращает пустой savedItems → бот подтверждает «без изменений»
// и НЕ создаёт InboxItem.
// ─────────────────────────────────────────────────────────────────────────
describe('process-message П8 — КЕЙС B повтор без изменений', () => {
  it('CONFIRMED conv + savedItems=[] → reply «Принято, без изменений.» и createInbox НЕ вызван', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    // conv уже CONFIRMED → ветка КЕЙС B (не PENDING-приём).
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'CONFIRMED',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    // saveBotOrders ничего не сохранил/не обновил — повтор без изменений.
    mockSave.mockResolvedValue({ savedItems: [] })
    // до cut-off: 15:48 МСК = 12:48 UTC
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('noop')
    expect(res.reply).toBe('Принято, без изменений.')
    expect(res.inboxItemId).toBeUndefined()
    expect(mockCreateInbox).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith('max_1', 'Принято, без изменений.')
  })

  it('CONFIRMED conv + savedItems непустой → обычная ветка updated с InboxItem', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'CONFIRMED',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    mockSave.mockResolvedValue({
      savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 12 }],
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'ANOMALY_HISTORICAL', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '12' })

    expect(res.action).toBe('updated')
    expect(res.reply).toContain('обновили')
    expect(mockCreateInbox).toHaveBeenCalledOnce()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// П3 (MEGA-4b): текстовый приём изменения заказа в spontaneous-ветке.
// Spontaneous достигается когда findLatestBotConv → null (нет PENDING/CONFIRMED).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Клиент для spontaneous-ветки: с активным DYNAMIC mealConfig (НЕ WEEKLY),
 * нужны id/locationId/orderType для П3-резолва.
 */
function makeSpontaneousClient(
  opts: { orderType?: string; mealType?: string } = {}
) {
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
        mealConfigs: [
          {
            id: 'cfg_1',
            locationId: 'loc_1',
            mealType: opts.mealType ?? 'LUNCH',
            orderType: opts.orderType ?? 'DYNAMIC',
            isActive: true,
            pricePerPortion: '300',
          },
        ],
      },
    ],
  }
}

describe('process-message П3 — текстовый приём изменения (spontaneous)', () => {
  beforeEach(() => {
    // По умолчанию spontaneous: нет cron-conv.
    mockFindConv.mockResolvedValue(null)
    mockFindClient.mockResolvedValue(makeSpontaneousClient())
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))
  })

  it('tone=rude + текст-интент → parseChangeIntent НЕ вызван, обычный NON_NUMERIC flow', async () => {
    mockClassifyTone.mockResolvedValue('rude')
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 13,
      date: '2026-06-05',
      mealType: 'ОБЕД',
      confidence: 0.97,
      reason: 'ok',
    })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13 на завтра, твари' })

    expect(mockParseChangeIntent).not.toHaveBeenCalled()
    expect(mockCreatePendingChange).not.toHaveBeenCalled()
    expect(res.action).toBe('inbox')
  })

  it('isWeekly клиент + текст-интент → parseChangeIntent НЕ вызван → NON_NUMERIC', async () => {
    mockFindClient.mockResolvedValue(makeSpontaneousClient({ orderType: 'WEEKLY' }))
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 13,
      date: '2026-06-05',
      mealType: 'ОБЕД',
      confidence: 0.97,
      reason: 'ok',
    })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13 обедов на завтра' })

    expect(mockParseChangeIntent).not.toHaveBeenCalled()
    expect(mockCreatePendingChange).not.toHaveBeenCalled()
    expect(res.action).toBe('inbox')
  })

  it('parseChangeIntent → NONE → старый NON_NUMERIC flow', async () => {
    mockParseChangeIntent.mockResolvedValue({ action: 'NONE', reason: 'no date' })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13' })

    expect(mockParseChangeIntent).toHaveBeenCalledOnce()
    expect(mockCreatePendingChange).not.toHaveBeenCalled()
    expect(res.action).toBe('inbox')
  })

  it('CHANGE + resolveTarget ambiguous_location → старый flow, inbox с пометкой «Не смог определить адрес»', async () => {
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 13,
      date: '2026-06-05',
      mealType: null,
      confidence: 0.95,
      reason: 'ok',
    })
    mockResolveTarget.mockReturnValue({ ok: false, reason: 'ambiguous_location' })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13 на завтра' })

    expect(mockCreatePendingChange).not.toHaveBeenCalled()
    expect(res.action).toBe('inbox')
    const inboxArg = mockCreateInbox.mock.calls.at(-1)?.[0]
    expect(inboxArg.reason).toBe('NON_NUMERIC')
    expect(inboxArg.humanReason).toContain('Не смог определить адрес')
    expect(inboxArg.humanReason).toContain('ambiguous_location')
  })

  it('CHANGE + existingOrder LOCKED → старый flow, пометка «уже в производстве»', async () => {
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 13,
      date: '2026-06-05',
      mealType: 'ОБЕД',
      confidence: 0.97,
      reason: 'ok',
    })
    mockResolveTarget.mockReturnValue({ ok: true, locationId: 'loc_1', mealType: 'LUNCH' })
    mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 10, status: 'LOCKED' })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13 обедов на завтра' })

    expect(mockCreatePendingChange).not.toHaveBeenCalled()
    expect(mockNotifyManagerOrderChange).not.toHaveBeenCalled()
    expect(res.action).toBe('inbox')
    const inboxArg = mockCreateInbox.mock.calls.at(-1)?.[0]
    expect(inboxArg.humanReason).toContain('уже в производстве')
  })

  it('CHANGE + existingOrder CONFIRMED → createPendingChange action=EDIT, notifyManager вызван', async () => {
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 13,
      date: '2026-06-05',
      mealType: 'ОБЕД',
      confidence: 0.97,
      reason: 'ok',
    })
    mockResolveTarget.mockReturnValue({ ok: true, locationId: 'loc_1', mealType: 'LUNCH' })
    mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 10, status: 'CONFIRMED' })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'надо 13 обедов на завтра' })

    expect(res.action).toBe('pending_order_change')
    expect(res.pendingId).toBe('pending_1')
    expect(mockCreatePendingChange).toHaveBeenCalledOnce()
    const pendingArg = mockCreatePendingChange.mock.calls[0][0]
    expect(pendingArg.action).toBe('EDIT')
    expect(pendingArg.currentOrderId).toBe('ord_1')
    expect(pendingArg.currentPortions).toBe(10)
    expect(pendingArg.proposedPortions).toBe(13)
    expect(pendingArg.sourceMaxChatId).toBe('max_1')
    expect(pendingArg.deliveryDate).toEqual(new Date('2026-06-05T00:00:00.000Z'))
    expect(mockNotifyManagerOrderChange).toHaveBeenCalledOnce()
    const notifyArg = mockNotifyManagerOrderChange.mock.calls[0][0]
    expect(notifyArg.action).toBe('EDIT')
    expect(notifyArg.changeId).toBe('pending_1')
    expect(notifyArg.currentPortions).toBe(10)
    expect(notifyArg.locationName).toBe('Офис')
    // notifyClientSignal НЕ вызывается на pending-ветке (менеджер уведомлён персонально).
    expect(mockNotifySignal).not.toHaveBeenCalled()
  })

  it('CHANGE + existingOrder=null → createPendingChange action=CREATE', async () => {
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      portions: 8,
      date: '2026-06-06',
      mealType: null,
      confidence: 0.96,
      reason: 'ok',
    })
    mockResolveTarget.mockReturnValue({ ok: true, locationId: 'loc_1', mealType: 'LUNCH' })
    mockFindActiveOrder.mockResolvedValue(null)

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'давайте 8 на 06.06' })

    expect(res.action).toBe('pending_order_change')
    expect(mockCreatePendingChange).toHaveBeenCalledOnce()
    const pendingArg = mockCreatePendingChange.mock.calls[0][0]
    expect(pendingArg.action).toBe('CREATE')
    expect(pendingArg.currentOrderId).toBeUndefined()
    expect(pendingArg.currentPortions).toBeNull()
    expect(pendingArg.proposedPortions).toBe(8)
    expect(mockNotifyManagerOrderChange).toHaveBeenCalledOnce()
  })
})
