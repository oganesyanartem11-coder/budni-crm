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
  mockNotifyProduction,
  mockCreateOrReuseAnomaly,
  mockEnsureAnomalyInbox,
  mockNotifyManagersAnomaly,
  anomalyFlag,
  mockHandleSticky,
} = vi.hoisted(() => ({
  mockHandleSticky: vi.fn(),
  // По умолчанию — как в проде (проверка аномалий отключена). describe про
  // подтверждение аномалий включает её, чтобы проверять сохранённый пайплайн.
  anomalyFlag: { enabled: false },
  mockPrisma: {
    user: { findMany: vi.fn() },
    client: { update: vi.fn(), findUnique: vi.fn() },
    botConversation: { update: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    inboxItem: { findFirst: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn() },
    clientPortionBaseline: { updateMany: vi.fn() },
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
  mockParseChangeIntent: vi.fn(),
  mockResolveTarget: vi.fn(),
  mockCreatePendingChange: vi.fn(),
  mockFindActiveOrder: vi.fn(),
  mockNotifyManagerOrderChange: vi.fn(),
  mockNotifyProduction: vi.fn(),
  mockCreateOrReuseAnomaly: vi.fn(),
  mockEnsureAnomalyInbox: vi.fn(),
  mockNotifyManagersAnomaly: vi.fn(),
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
vi.mock('./sticky', async () => {
  const actual = await vi.importActual<typeof import('./sticky')>('./sticky')
  return { ...actual, handleStickyMessage: mockHandleSticky }
})
vi.mock('@/lib/orders/anomaly-constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orders/anomaly-constants')>(
    '@/lib/orders/anomaly-constants',
  )
  return {
    ...actual,
    get ANOMALY_CHECK_ENABLED() {
      return anomalyFlag.enabled
    },
  }
})
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
const { mockSubmitRange, mockNotifyRange } = vi.hoisted(() => ({
  mockSubmitRange: vi.fn(),
  mockNotifyRange: vi.fn(),
}))
vi.mock('@/lib/telegram/handlers/order-change', () => ({
  notifyManagerAboutOrderChange: mockNotifyManagerOrderChange,
  notifyManagerAboutRangeChange: mockNotifyRange,
}))
vi.mock('@/lib/order-changes/range-request', () => ({ submitClientRangeRequest: mockSubmitRange }))
vi.mock('@/lib/orders/anomaly-confirmations', () => ({
  createOrReusePendingAnomalyConfirmation: mockCreateOrReuseAnomaly,
  ensurePendingAnomalyInbox: mockEnsureAnomalyInbox,
}))
vi.mock('@/lib/telegram/handlers/anomaly-confirmation', () => ({
  notifyManagersAboutAnomaly: mockNotifyManagersAnomaly,
}))
// #3: спай на notifyProductionChannel (post-cutoff уведомление производства),
// escapeHtml оставляем реальным через importActual — иначе сломается HTML-форматирование.
vi.mock('@/lib/telegram/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telegram/notify')>()
  return { ...actual, notifyProductionChannel: mockNotifyProduction }
})

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
        mealConfigs: [{ mealType: 'LUNCH', pricePerPortion: '300', isActive: true, orderType: 'DYNAMIC' }],
      },
    ],
  }
}

function makeMultiMealClient() {
  const client = makeClient()
  return {
    ...client,
    locations: client.locations.map((location) => ({
      ...location,
      mealConfigs: [
        { mealType: 'LUNCH', pricePerPortion: '300', isActive: true, orderType: 'DYNAMIC' },
        { mealType: 'DINNER', pricePerPortion: '350', isActive: true, orderType: 'DYNAMIC' },
      ],
    })),
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
  mockNotifyProduction.mockResolvedValue(undefined)
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
  mockCreateOrReuseAnomaly.mockResolvedValue({
    confirmation: { id: 'anom_1', status: 'PENDING' },
    reused: false,
  })
  mockEnsureAnomalyInbox.mockResolvedValue({ id: 'inbox_anom_1' })
  mockNotifyManagersAnomaly.mockResolvedValue(undefined)
  mockPrisma.clientPortionBaseline.updateMany.mockResolvedValue({ count: 0 })
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

  it('post-cutoff 16:30 МСК + заказ создан (savedItems непуст) → человечный приём', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    // 16:30 МСК = 13:30 UTC
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 13, 30, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    // #3: при savedItems непусто (заказ создан на завтра) — человечное подтверждение
    // «Принято: ... на DD MMMM. ... до 16:00», а не generic «сложнее».
    expect(res.action).toBe('post_cutoff')
    expect(res.reply).toContain('Принято')
    expect(res.reply).toContain('Офис — 10')
    expect(res.reply).toContain('5 июня')
    expect(res.reply).toContain('16:00')
    expect(res.reply).not.toMatch(/сложнее/i)

    // Side-effect: производство уведомлено о позднем приёме (ключевой признак фикса).
    expect(mockNotifyProduction).toHaveBeenCalledTimes(1)
    const prodText = mockNotifyProduction.mock.calls[0][0] as string
    expect(prodText).toContain('ответил после приёма заявок')
    expect(prodText).toContain('Офис — 10')
  })

  it('post-cutoff 16:30 МСК + savedItems=[] (нет конфига/цены) → generic «сложнее»', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    mockSave.mockResolvedValue({ savedItems: [] })
    // 16:30 МСК = 13:30 UTC
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 13, 30, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('post_cutoff')
    expect(res.reply).toMatch(/сложнее/i)
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
      savedItems: [
        {
          locationId: 'loc_1',
          locationName: 'Офис',
          mealType: 'LUNCH',
          portions: 12,
          wasUpdate: true,
          previousPortions: 10,
        },
      ],
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'ANOMALY_HISTORICAL', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '12' })

    expect(res.action).toBe('updated')
    expect(res.reply).toContain('обновили')
    expect(mockCreateInbox).toHaveBeenCalledOnce()
  })

  // F3: изменение порций уже подтверждённого заказа ДОЛЖНО уведомить производство.
  it('F3: CONFIRMED conv + изменение порций (wasUpdate) → notifyProductionChannel «было → стало»', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'CONFIRMED',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    mockSave.mockResolvedValue({
      savedItems: [
        {
          locationId: 'loc_1',
          locationName: 'Офис',
          mealType: 'LUNCH',
          portions: 12,
          wasUpdate: true,
          previousPortions: 10,
        },
      ],
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'ANOMALY_HISTORICAL', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '12' })

    expect(res.action).toBe('updated')
    // Производство уведомлено ровно один раз (без дублей).
    expect(mockNotifyProduction).toHaveBeenCalledTimes(1)
    const prodText = mockNotifyProduction.mock.calls[0][0] as string
    expect(prodText).toContain('обновил заказ')
    expect(prodText).toContain('Тест Клиент')
    expect(prodText).toContain('Офис')
    expect(prodText).toContain('было 10')
    expect(prodText).toContain('стало 12')
    expect(prodText).toContain('5 июня')
  })

  it('F3: повтор без изменений (savedItems=[]) → notifyProductionChannel НЕ вызван', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'CONFIRMED',
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    mockSave.mockResolvedValue({ savedItems: [] })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 12, 48, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(res.action).toBe('noop')
    expect(mockNotifyProduction).not.toHaveBeenCalled()
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

// ─────────────────────────────────────────────────────────────────────────
// Волна 2 (баг A/B): дата из ТЕКСТА приоритетнее даты «висящей» беседы.
// extractDeliveryDateFromText использует замоканный parseChangeIntent; regex-гейт
// реальный (сообщения с признаком даты доходят до мока, «10» — нет).
// ─────────────────────────────────────────────────────────────────────────
describe('process-message — дата из текста приоритетнее беседы (Волна 2, баг A/B)', () => {
  it('висящая беседа на прошедшей дате + «На 6 июля 5 обедов» → заказ на 6 июля, без лекции 16:00', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    // Беседа «висит» на прошедшей дате (11 июня).
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 6, 11),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 5 }],
    })
    mockSave.mockResolvedValue({
      savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 5 }],
    })
    // Дата из текста: 6 июля (валидна, будущая относительно «сегодня» = 1 июля).
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      date: '2026-07-06',
      portions: 5,
      mealType: null,
      confidence: 0.99,
      reason: 'ok',
    })
    // 1 июля 11:00 МСК = 08:00 UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 1, 8, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'На 6 июля 5 обедов' })

    // Баг A: заказ сохранён на 6 июля (из текста), а НЕ на 11 июня (из беседы).
    expect(mockSave).toHaveBeenCalledTimes(1)
    const saveArg = mockSave.mock.calls[0][0] as { deliveryDate: Date }
    expect(saveArg.deliveryDate.getTime()).toBe(Date.UTC(2026, 6, 6))
    // Дата 6 июля фигурирует в уведомлении производству (а не 11 июня).
    expect(mockNotifyProduction).toHaveBeenCalled()
    expect(mockNotifyProduction.mock.calls[0][0] as string).toContain('6 июля')
    expect(mockNotifyProduction.mock.calls[0][0] as string).not.toContain('июня')
    // Баг B: приём до cutoff (11:00 про будущий день) → без лекции про 16:00.
    expect(res.action).toBe('saved')
    expect(res.reply).toContain('Принято')
    expect(res.reply).not.toContain('16:00')
    expect(res.reply).not.toMatch(/сложнее/i)
  })

  it('11:00 МСК, беседа висит на СЕГОДНЯ, «на завтра 8» → afterCutoff=false, ответ без лекции', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    // Беседа на СЕГОДНЯ (4 июля) — раньше это давало ложный afterCutoff в 11:00.
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 7, 4),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 8 }],
    })
    mockSave.mockResolvedValue({
      savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 8 }],
    })
    // «на завтра» = 5 июля (относительно 4 июля).
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      date: '2026-07-05',
      portions: 8,
      mealType: null,
      confidence: 0.99,
      reason: 'ok',
    })
    // 4 июля 11:00 МСК = 08:00 UTC.
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 4, 8, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'на завтра 8' })

    // Отсечка считается от 5 июля (завтра) → сегодня 16:00 ещё впереди → без лекции.
    expect(res.action).toBe('saved')
    expect(res.reply).toContain('Принято')
    expect(res.reply).not.toContain('16:00')
    expect(res.reply).not.toMatch(/сложнее/i)
    // Заказ сохранён на 5 июля (завтра), а не на сегодня.
    const saveArg = mockSave.mock.calls[0][0] as { deliveryDate: Date }
    expect(saveArg.deliveryDate.getTime()).toBe(Date.UTC(2026, 6, 5))
  })

  it('17:00 МСК, «на завтра 8» → afterCutoff=true, лекция про 16:00 уходит законно', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 7, 4),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 8 }],
    })
    mockSave.mockResolvedValue({
      savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 8 }],
    })
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      date: '2026-07-05',
      portions: 8,
      mealType: null,
      confidence: 0.99,
      reason: 'ok',
    })
    // 4 июля 17:00 МСК = 14:00 UTC (после 16:00 отсечки для доставки завтра).
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 4, 14, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'на завтра 8' })

    expect(res.action).toBe('post_cutoff')
    expect(res.reply).toContain('Принято')
    expect(res.reply).toContain('16:00')
    expect(res.reply).toContain('5 июля')
  })
})

describe('process-message — маршрутизация STICKY', () => {
  function makeStickyClient() {
    const client = makeClient()
    return {
      ...client,
      locations: client.locations.map((l) => ({
        ...l,
        mealConfigs: [{ mealType: 'LUNCH', pricePerPortion: '300', isActive: true, orderType: 'STICKY' }],
      })),
    }
  }

  it('число от STICKY-клиента → sticky-ветка, без вопросов/бесед DYNAMIC', async () => {
    mockFindClient.mockResolvedValue(makeStickyClient())
    mockHandleSticky.mockResolvedValue({ reply: 'Принято! …', changed: true })

    const result = await processClientMessage({ maxChatId: 'max_1', text: '40' })

    expect(result).toEqual({ reply: 'Принято! …', action: 'updated' })
    expect(mockHandleSticky).toHaveBeenCalledWith(expect.objectContaining({ id: 'client_1' }), '40', 'max_1')
    expect(mockFindConv).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('не-число от STICKY-клиента → обычная spontaneous-ветка (inbox)', async () => {
    mockFindClient.mockResolvedValue(makeStickyClient())
    mockHandleSticky.mockResolvedValue(null)

    const result = await processClientMessage({ maxChatId: 'max_1', text: 'завтра не нужно' })

    expect(result.action).toBe('inbox')
    expect(mockFindConv).not.toHaveBeenCalled()
    expect(mockCreateInbox).toHaveBeenCalled()
  })

  it('DYNAMIC-клиент в sticky-ветку не попадает', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue(null)

    await processClientMessage({ maxChatId: 'max_1', text: 'привет' })

    expect(mockHandleSticky).not.toHaveBeenCalled()
  })
})

describe('process-message — ANOMALY_CHECK_ENABLED=false (проверка отключена)', () => {
  it('число 5 после обычных 50 применяется сразу, без PendingAnomalyConfirmation и детектора', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 5 }],
    })
    // Даже если бы детектор сказал «аномалия» — он не должен вызываться.
    mockDetectAnomalies.mockReturnValue({ isAnomaly: true, reason: 'NEW_CLIENT', priority: 'NORMAL' })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 25, max: 100, average: 50, samples: 10 },
    })
    mockSave.mockResolvedValue({
      savedItems: [{ locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 5 }],
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: '5' })

    expect(result.action).toBe('saved')
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ locationId: 'loc_1', portions: 5 }] }),
    )
    expect(mockDetectAnomalies).not.toHaveBeenCalled()
    expect(mockDetectPortionAnomaly).not.toHaveBeenCalled()
    expect(mockCreateOrReuseAnomaly).not.toHaveBeenCalled()
    expect(mockNotifyManagersAnomaly).not.toHaveBeenCalled()
  })

  it('грубый тон с числом больше не блокирует заказ (тон-алёрт остаётся)', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'rude',
      items: [{ locationId: 'loc_1', portions: 12 }],
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: '12 И ПОБЫСТРЕЕ' })

    expect(result.action).toBe('saved')
    expect(mockSave).toHaveBeenCalledOnce()
    expect(mockNotifySignal).toHaveBeenCalledWith(expect.objectContaining({ tone: 'rude' }))
  })

  it('не-числовой ответ (вопрос) по-прежнему уходит в inbox', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'question',
      confidence: 0.9,
      reason: 'вопрос',
      toneLabel: 'neutral',
      items: [],
    })
    mockDetectAnomalies.mockReturnValue({
      isAnomaly: true,
      reason: 'NON_NUMERIC',
      humanReason: 'вопрос',
      priority: 'NORMAL',
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: 'а что в меню?' })

    expect(result.action).toBe('inbox')
    expect(mockSave).not.toHaveBeenCalled()
  })
})

describe('process-message — подтверждение аномалии порций', () => {
  beforeEach(() => {
    anomalyFlag.enabled = true
  })
  afterEach(() => {
    anomalyFlag.enabled = false
  })

  it('baseline=30, proposed=28 → штатно сохраняет и drift обновляет только существующий baseline', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 28 }],
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: false,
      reason: null,
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockSave.mockResolvedValue({
      savedItems: [
        { locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 28 },
      ],
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: '28' })

    expect(result.action).toBe('saved')
    expect(mockSave).toHaveBeenCalledOnce()
    expect(mockPrisma.clientPortionBaseline.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client_1', locationId: 'loc_1' },
      data: { portions: 28, updatedById: null },
    })
    expect(mockCreateOrReuseAnomaly).not.toHaveBeenCalled()
  })

  it('baseline=30, proposed=5 → Order не создаётся, PENDING + holding reply + TG-кнопки', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 6),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 5 }],
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE',
      date: '2026-08-08',
      portions: 5,
      mealType: null,
      confidence: 0.99,
      reason: 'ok',
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({
      maxChatId: 'max_1',
      text: 'на 8 августа 5',
    })

    const effectiveDate = new Date('2026-08-08T00:00:00.000Z')
    expect(mockDetectPortionAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryDate: effectiveDate, proposedPortions: 5 }),
      mockPrisma,
    )
    expect(mockGetStats).toHaveBeenCalledWith('client_1', effectiveDate.getUTCDay())
    expect(mockCreateOrReuseAnomaly).toHaveBeenCalledWith({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: effectiveDate,
      proposedPortions: 5,
      conversationId: 'conv_1',
    })
    expect(mockNotifyManagersAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      confirmationId: 'anom_1',
      clientName: 'Тест Клиент',
      locationName: 'Офис',
      deliveryDate: effectiveDate,
      proposedPortions: 5,
      comparisonSource: 'baseline',
      reason: 'below_threshold',
    }))
    expect(mockPrisma.botConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'AWAITING_MANAGER' },
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockSendBotMessage).toHaveBeenCalledWith(
      'max_1',
      'Принято, уточняем по вашему заказу — вернёмся.',
    )
    expect(result).toEqual({
      reply: 'Принято, уточняем по вашему заказу — вернёмся.',
      action: 'pending_anomaly_confirmation',
      pendingId: 'anom_1',
    })
  })

  it('ошибка Telegram не роняет MAX-flow: pending остаётся, создаётся один inbox fallback', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockNotifyManagersAnomaly.mockRejectedValue(new Error('telegram unavailable'))
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(mockSave).not.toHaveBeenCalled()
    expect(mockEnsureAnomalyInbox).toHaveBeenCalledOnce()
    expect(mockEnsureAnomalyInbox).toHaveBeenCalledWith(expect.objectContaining({
      confirmationId: 'anom_1',
      clientId: 'client_1',
      conversationId: 'conv_1',
    }))
    expect(result).toEqual({
      reply: 'Принято, уточняем по вашему заказу — вернёмся.',
      action: 'pending_anomaly_confirmation',
      pendingId: 'anom_1',
      inboxItemId: 'inbox_anom_1',
    })
  })

  it('два active config: конкретный DINNER из parsed item не заменяется первым LUNCH', async () => {
    mockFindClient.mockResolvedValue(makeMultiMealClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 5, mealType: 'DINNER' }],
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({ maxChatId: 'max_1', text: 'на ужин 5' })

    expect(mockParse.mock.calls[0][0].locations).toEqual([
      expect.objectContaining({ id: 'loc_1', mealTypes: ['LUNCH', 'DINNER'] }),
    ])
    expect(mockCreateOrReuseAnomaly).toHaveBeenCalledWith({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'DINNER',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
      proposedPortions: 5,
      conversationId: 'conv_1',
    })
    expect(mockNotifyManagersAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ mealType: 'DINNER' }),
    )
    expect(mockSave).not.toHaveBeenCalled()
    expect(result.pendingId).toBe('anom_1')
  })

  it('два active config без mealType: не выдумывает тип, переиспользует inbox и не обещает заказ', async () => {
    mockFindClient.mockResolvedValue(makeMultiMealClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 5 }],
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockPrisma.inboxItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'inbox_ambiguous', reason: 'ANOMALY_HISTORICAL' })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const first = await processClientMessage({ maxChatId: 'max_1', text: '5 порций' })
    const second = await processClientMessage({ maxChatId: 'max_1', text: '5 порций' })

    expect(mockCreateOrReuseAnomaly).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockCreateInbox).toHaveBeenCalledOnce()
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client_1',
        conversationId: 'conv_1',
        reason: 'ANOMALY_HISTORICAL',
        humanReason: expect.stringContaining('не удалось определить тип питания'),
      }),
    )
    expect(mockSendBotMessage).not.toHaveBeenCalled()
    expect(first).toEqual({ reply: null, action: 'inbox', inboxItemId: 'inbox_1' })
    expect(second).toEqual({
      reply: null,
      action: 'inbox',
      inboxItemId: 'inbox_ambiguous',
    })
  })

  it('несколько конкретных meal items создают отдельные pending со своими mealType', async () => {
    mockFindClient.mockResolvedValue(makeMultiMealClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'PENDING',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.99,
      reason: null,
      toneLabel: 'neutral',
      items: [
        { locationId: 'loc_1', portions: 5, mealType: 'LUNCH' },
        { locationId: 'loc_1', portions: 7, mealType: 'DINNER' },
      ],
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockCreateOrReuseAnomaly
      .mockResolvedValueOnce({ confirmation: { id: 'anom_lunch' }, reused: false })
      .mockResolvedValueOnce({ confirmation: { id: 'anom_dinner' }, reused: false })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const result = await processClientMessage({
      maxChatId: 'max_1',
      text: 'на обед 5, на ужин 7',
    })

    expect(mockCreateOrReuseAnomaly).toHaveBeenCalledTimes(2)
    expect(mockCreateOrReuseAnomaly.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ mealType: 'LUNCH', proposedPortions: 5, conversationId: 'conv_1' }),
      expect.objectContaining({ mealType: 'DINNER', proposedPortions: 7, conversationId: 'conv_1' }),
    ])
    expect(mockNotifyManagersAnomaly).toHaveBeenCalledTimes(2)
    expect(mockSendBotMessage).toHaveBeenCalledOnce()
    expect(mockSave).not.toHaveBeenCalled()
    expect(result).toEqual({
      reply: 'Принято, уточняем по вашему заказу — вернёмся.',
      action: 'pending_anomaly_confirmation',
      pendingId: 'anom_lunch',
    })
  })

  it('повторная обработка использует тот же PENDING вместо второго create', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_1',
      status: 'AWAITING_MANAGER',
      deliveryDate: mskMidnightUtc(2026, 8, 7),
    })
    mockDetectPortionAnomaly.mockResolvedValue({
      isAnomaly: true,
      reason: 'below_threshold',
      expected: { min: 15, max: 60, average: 30, samples: 1 },
      source: 'baseline',
    })
    mockCreateOrReuseAnomaly.mockResolvedValue({
      confirmation: { id: 'anom_existing', status: 'PENDING' },
      reused: true,
    })
    vi.setSystemTime(new Date('2026-08-06T08:00:00.000Z'))

    const first = await processClientMessage({ maxChatId: 'max_1', text: '10' })
    const second = await processClientMessage({ maxChatId: 'max_1', text: '10' })

    expect(first.pendingId).toBe('anom_existing')
    expect(second.pendingId).toBe('anom_existing')
    expect(mockCreateOrReuseAnomaly).toHaveBeenCalledTimes(2)
    expect(mockSave).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 07.10: «добавьте / уберите N» понимается во всех типах питания.
// DYNAMIC (ответ на вопрос дня) — mode='add' уходит в saveBotOrders, там
// итог = заказ + изменение; FIXED/любой клиент без беседы — PendingOrderChange
// с итогом «было + изменение»; STICKY — sticky.test.ts; WEEKLY — weekly/*.
// ─────────────────────────────────────────────────────────────────────
describe('process-message — «добавьте / уберите» (07.10)', () => {
  it('DYNAMIC: «добавьте 2 обеда» → в saveBotOrders уходит mode=add, клиенту итог', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'CONFIRMED', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    mockParse.mockResolvedValue({
      type: 'numeric',
      confidence: 0.95,
      reason: null,
      toneLabel: 'neutral',
      items: [{ locationId: 'loc_1', portions: 2, mealType: 'LUNCH', mode: 'add' }],
    })
    mockSave.mockResolvedValue({
      savedItems: [
        { locationId: 'loc_1', locationName: 'Офис', mealType: 'LUNCH', portions: 12, wasUpdate: true, previousPortions: 10 },
      ],
      unmatchedItems: [],
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_1', reason: 'ANOMALY_HISTORICAL', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 10, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'добавьте 2 обеда' })

    expect(mockSave.mock.calls[0][0].items).toEqual([
      { locationId: 'loc_1', portions: 2, mealType: 'LUNCH', mode: 'add' },
    ])
    expect(res.reply).toBe('Принято, обновили на 12 порций.')
  })

  it('DYNAMIC: «добавьте 2», а прибавлять не к чему → не «принято», а менеджеру', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'PENDING', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    mockSave.mockResolvedValue({
      savedItems: [],
      unmatchedItems: [
        { locationId: 'loc_1', portions: 2, reason: 'заказа на этот день ещё нет — не к чему прибавить' },
      ],
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_9', reason: 'NON_NUMERIC', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 10, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'добавьте 2' })

    expect(res).toEqual({ reply: null, action: 'inbox', inboxItemId: 'inbox_9' })
    expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('не к чему прибавить')
    expect(mockSendBotMessage).not.toHaveBeenCalled()
  })

  describe('FIXED / сообщение вне вопроса дня', () => {
    beforeEach(() => {
      mockFindConv.mockResolvedValue(null)
      mockFindClient.mockResolvedValue(makeClient())
      vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))
    })

    it('«на завтра добавьте 1 обед» при заказе 34 → менеджеру предложение 34 → 35', async () => {
      mockParseChangeIntent.mockResolvedValue({
        action: 'CHANGE',
        portions: 1,
        mode: 'add',
        date: '2026-06-05',
        mealType: 'ОБЕД',
        confidence: 0.96,
        reason: 'ok',
      })
      mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 34, status: 'CONFIRMED' })

      const res = await processClientMessage({ maxChatId: 'max_1', text: 'на завтра добавьте 1 обед' })

      expect(res.action).toBe('pending_order_change')
      const pendingArg = mockCreatePendingChange.mock.calls[0][0]
      expect(pendingArg).toMatchObject({ action: 'EDIT', currentPortions: 34, proposedPortions: 35 })
      expect(mockNotifyManagerOrderChange.mock.calls[0][0]).toMatchObject({ currentPortions: 34, proposedPortions: 35 })
    })

    it('«в пятницу на 3 меньше» при заказе 10 → 7', async () => {
      mockParseChangeIntent.mockResolvedValue({
        action: 'CHANGE',
        portions: -3,
        mode: 'add',
        date: '2026-06-05',
        mealType: null,
        confidence: 0.95,
        reason: 'ok',
      })
      mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 10, status: 'CONFIRMED' })

      await processClientMessage({ maxChatId: 'max_1', text: 'в пятницу на 3 меньше' })

      expect(mockCreatePendingChange.mock.calls[0][0]).toMatchObject({ proposedPortions: 7 })
    })

    it('«добавьте 2», а заказа на дату нет → менеджеру в inbox, без предложения', async () => {
      mockParseChangeIntent.mockResolvedValue({
        action: 'CHANGE',
        portions: 2,
        mode: 'add',
        date: '2026-06-05',
        mealType: null,
        confidence: 0.95,
        reason: 'ok',
      })
      mockFindActiveOrder.mockResolvedValue(null)
      mockCreateInbox.mockResolvedValue({ id: 'inbox_d', reason: 'NON_NUMERIC', priority: 'NORMAL' })

      const res = await processClientMessage({ maxChatId: 'max_1', text: 'добавьте 2 на завтра' })

      expect(res).toEqual({ reply: null, action: 'inbox', inboxItemId: 'inbox_d' })
      expect(mockCreatePendingChange).not.toHaveBeenCalled()
      expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('заказа на 2026-06-05 нет')
    })

    it('«уберите 5» при заказе 3 → менеджеру, а не минус в заказе', async () => {
      mockParseChangeIntent.mockResolvedValue({
        action: 'CHANGE',
        portions: -5,
        mode: 'add',
        date: '2026-06-05',
        mealType: null,
        confidence: 0.95,
        reason: 'ok',
      })
      mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 3, status: 'CONFIRMED' })
      mockCreateInbox.mockResolvedValue({ id: 'inbox_n', reason: 'NON_NUMERIC', priority: 'NORMAL' })

      await processClientMessage({ maxChatId: 'max_1', text: 'уберите 5 на завтра' })

      expect(mockCreatePendingChange).not.toHaveBeenCalled()
      expect(mockCreateInbox.mock.calls[0][0].humanReason).toContain('в заказе 3')
    })
  })
})


// ─────────────────────────────────────────────────────────────────────
// 07.10: изменение на период «с 7 по 14 +1 обед» — для клиента любого типа
// (FIXED/DYNAMIC вне вопроса дня, DYNAMIC в ответ на вопрос дня).
// ─────────────────────────────────────────────────────────────────────
describe('process-message — изменение на период', () => {
  const RANGE_INTENT = {
    action: 'CHANGE',
    portions: 1,
    mode: 'add',
    date: '2026-06-08',
    dateTo: '2026-06-12',
    mealType: 'ОБЕД',
    confidence: 0.96,
    reason: 'ok',
  }
  const PLAN = { lines: [{ orderId: 'o1' }], skipped: [], missingDates: [] }

  beforeEach(() => {
    mockFindClient.mockResolvedValue(makeClient())
    mockSubmitRange.mockResolvedValue({ kind: 'pending', requestId: 'req_1', plan: PLAN })
    mockNotifyRange.mockResolvedValue(undefined)
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))
  })

  it('вне вопроса дня (FIXED): один запрос на весь период, менеджеру одно сообщение', async () => {
    mockFindConv.mockResolvedValue(null)
    mockParseChangeIntent.mockResolvedValue(RANGE_INTENT)

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'с 8 по 12 +1 обед' })

    expect(res).toEqual({ reply: null, action: 'pending_order_change', pendingId: 'req_1' })
    expect(mockSubmitRange.mock.calls[0][0]).toMatchObject({
      clientId: 'client_1',
      sourceMaxChatId: 'max_1',
      request: {
        clientId: 'client_1',
        locationId: 'loc_1',
        mealTypes: ['LUNCH'],
        dateFrom: '2026-06-08',
        dateTo: '2026-06-12',
        mode: 'add',
        portions: 1,
      },
    })
    expect(mockNotifyRange).toHaveBeenCalledOnce()
    expect(mockCreatePendingChange).not.toHaveBeenCalled()
  })

  it('в ответ на вопрос дня (DYNAMIC): период не становится числом на завтра', async () => {
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'PENDING', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    mockParseChangeIntent.mockResolvedValue(RANGE_INTENT)

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'с 8 по 12 +1 обед' })

    expect(res.action).toBe('pending_order_change')
    expect(mockParse).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockPrisma.botConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'AWAITING_MANAGER' },
    })
  })

  it('в ответ на вопрос дня, но это не период (LLM: NONE) → обычный ответ числом', async () => {
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'PENDING', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    mockParseChangeIntent.mockResolvedValue({ action: 'NONE', reason: 'no' })

    await processClientMessage({ maxChatId: 'max_1', text: 'с 9 утра будем, 10 порций' })

    expect(mockParse).toHaveBeenCalled()
    expect(mockSubmitRange).not.toHaveBeenCalled()
  })

  it('обычное число в ответ на вопрос дня — без лишнего LLM-вызова', async () => {
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'PENDING', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    await processClientMessage({ maxChatId: 'max_1', text: '12' })
    expect(mockParseChangeIntent).not.toHaveBeenCalled()
  })

  it('менять нечего → менеджеру в inbox с причиной', async () => {
    mockFindConv.mockResolvedValue(null)
    mockParseChangeIntent.mockResolvedValue(RANGE_INTENT)
    mockSubmitRange.mockResolvedValue({ kind: 'nothing', plan: PLAN, reason: 'на эти дни заказов нет' })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_r', reason: 'NON_NUMERIC', priority: 'NORMAL' })

    const res = await processClientMessage({ maxChatId: 'max_1', text: 'с 8 по 12 +1 обед' })

    expect(res).toEqual({ reply: null, action: 'inbox', inboxItemId: 'inbox_r' })
    expect(mockCreateInbox.mock.calls.at(-1)![0].humanReason).toContain('нечего менять (на эти дни заказов нет)')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Аудит 08.10: маршрутизация ответа и защита от записи не туда.
// ─────────────────────────────────────────────────────────────────────
describe('process-message — аудит 08.10', () => {
  it('FIXED-клиент с открытой беседой → не сохраняем сразу, а через менеджера (spontaneous)', async () => {
    const fixed = makeClient()
    fixed.locations[0].mealConfigs = [
      { mealType: 'LUNCH', pricePerPortion: '300', isActive: true, orderType: 'FIXED' },
    ] as never
    mockFindClient.mockResolvedValue(fixed)
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'CONFIRMED', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))

    await processClientMessage({ maxChatId: 'max_1', text: 'на завтра 15 вместо 10' })

    expect(mockFindConv).not.toHaveBeenCalled()
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockParseChangeIntent).toHaveBeenCalled()
  })

  it('«Добрый день», потом «20»: сегодняшняя беседа у менеджера → «20» — первый ответ на неё', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_today',
      status: 'AWAITING_MANAGER',
      createdAt: new Date(Date.UTC(2026, 5, 4, 8, 0, 0)),
      deliveryDate: mskMidnightUtc(2026, 6, 5),
    })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '20' })

    expect(res.action).toBe('saved')
    expect(mockPrisma.botConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_today' },
      data: { status: 'CONFIRMED' },
    })
  })

  it('число без даты на вчерашний вопрос, доставка по нему сегодня → спрашиваем день, не пишем в закрытый день', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_yday',
      status: 'CONFIRMED',
      createdAt: new Date(Date.UTC(2026, 5, 3, 8, 0, 0)),
      deliveryDate: mskMidnightUtc(2026, 6, 4),
    })
    mockCreateInbox.mockResolvedValue({ id: 'inbox_s', reason: 'NON_NUMERIC', priority: 'NORMAL' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 7, 30, 0))) // 10:30 МСК

    const res = await processClientMessage({ maxChatId: 'max_1', text: '7' })

    expect(mockSave).not.toHaveBeenCalled()
    expect(res).toMatchObject({ action: 'inbox', reply: 'Спасибо! Подскажите, пожалуйста, на какой день это количество?' })
    expect(mockSendBotMessage).toHaveBeenCalledWith('max_1', 'Спасибо! Подскажите, пожалуйста, на какой день это количество?')
  })

  it('та же ситуация, но клиент назвал день («на завтра 7») → сохраняем на завтра', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({
      id: 'conv_yday',
      status: 'CONFIRMED',
      createdAt: new Date(Date.UTC(2026, 5, 3, 8, 0, 0)),
      deliveryDate: mskMidnightUtc(2026, 6, 4),
    })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 7, 30, 0)))

    await processClientMessage({ maxChatId: 'max_1', text: 'на завтра 7' })

    expect(mockSave.mock.calls[0][0].deliveryDate).toEqual(new Date('2026-06-05T00:00:00.000Z'))
  })

  it('сбой распознавания → сообщение не теряется: inbox HIGH, беседа менеджеру', async () => {
    mockFindClient.mockResolvedValue(makeClient())
    mockFindConv.mockResolvedValue({ id: 'conv_1', status: 'PENDING', deliveryDate: mskMidnightUtc(2026, 6, 5) })
    mockParse.mockRejectedValue(new Error('overloaded'))
    mockCreateInbox.mockResolvedValue({ id: 'inbox_e', reason: 'NON_NUMERIC', priority: 'HIGH' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))

    const res = await processClientMessage({ maxChatId: 'max_1', text: '12' })

    expect(res).toEqual({ reply: null, action: 'inbox', inboxItemId: 'inbox_e' })
    expect(mockLogBotMessage).toHaveBeenCalledWith(expect.objectContaining({ direction: 'IN', text: '12' }))
    expect(mockCreateInbox.mock.calls[0][0]).toMatchObject({ priority: 'HIGH' })
    expect(mockPrisma.botConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv_1' },
      data: { status: 'AWAITING_MANAGER' },
    })
  })

  it('«добавьте 1» вне вопроса дня → в запрос пишется изменение (+1 дважды = +2 при подтверждении)', async () => {
    mockFindConv.mockResolvedValue(null)
    mockFindClient.mockResolvedValue(makeClient())
    mockParseChangeIntent.mockResolvedValue({
      action: 'CHANGE', portions: 1, mode: 'add', date: '2026-06-05', dateTo: null, mealType: null, confidence: 0.95, reason: '',
    })
    mockFindActiveOrder.mockResolvedValue({ id: 'ord_1', portions: 10, status: 'CONFIRMED' })
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 4, 9, 0, 0)))

    await processClientMessage({ maxChatId: 'max_1', text: 'на завтра добавьте 1' })

    expect(mockCreatePendingChange.mock.calls[0][0]).toMatchObject({ proposedPortions: 11, deltaPortions: 1 })
  })
})
