import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * STICKY «По последнему числу»: число клиента → постоянное количество с
 * ближайшего редактируемого дня; будущие заказы пересчитываются; заказы с УПД
 * не трогаются; генерация — как FIXED.
 */

const { mockPrisma, mockParse, mockSetPortions, mockSend, mockLog, mockNotifyProd } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn(), createMany: vi.fn() },
    clientMealConfig: { update: vi.fn(), findMany: vi.fn() },
    activityLog: { create: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  mockParse: vi.fn(),
  mockSetPortions: vi.fn(),
  mockSend: vi.fn(),
  mockLog: vi.fn(),
  mockNotifyProd: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/llm/parser', () => ({ parseClientResponse: mockParse }))
vi.mock('@/lib/orders/client-stats', () => ({
  getClientStats: vi.fn(async () => ({ recentOrders: [] })),
}))
vi.mock('@/lib/orders/client-portions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/orders/client-portions')>(
    '@/lib/orders/client-portions',
  )
  return {
    ...actual,
    resolveSystemActor: vi.fn(async () => ({ id: 'admin_pro_1', role: 'ADMIN_PRO' })),
    setOrderPortionsForClient: mockSetPortions,
  }
})
vi.mock('@/lib/bot/max-users', () => ({ promoteToActiveByChatId: vi.fn(async () => {}) }))
vi.mock('@/lib/max/send-message', () => ({ sendBotMessage: mockSend }))
vi.mock('./log-message', () => ({ logBotMessage: mockLog }))
vi.mock('@/lib/telegram/notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/telegram/notify')>('@/lib/telegram/notify')
  return { ...actual, notifyProductionChannel: mockNotifyProd }
})

import { handleStickyMessage, isStickyClient } from './sticky'
import { generateFixedOrdersForRange } from '@/lib/orders/generate-orders'

const STICKY_CONFIG = {
  id: 'cfg_s',
  clientId: 'client_h',
  locationId: 'loc_1',
  mealType: 'LUNCH',
  orderType: 'STICKY',
  scheduleType: 'WEEKDAYS',
  scheduleData: null,
  fixedPortions: 33,
  pricePerPortion: '300',
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validTo: null,
  isActive: true,
}

function makeClient(configOverrides: Record<string, unknown> = {}) {
  return {
    id: 'client_h',
    name: 'ХАЛВА',
    isActive: true,
    locationAliases: {},
    locations: [
      {
        id: 'loc_1',
        name: 'Офис',
        isActive: true,
        sameDayDelivery: false,
        cutoffHourMsk: null,
        cutoffMinuteMsk: null,
        mealConfigs: [{ ...STICKY_CONFIG, ...configOverrides }],
      },
    ],
  } as never
}

function numeric(portions: number) {
  return {
    type: 'numeric',
    confidence: 0.99,
    reason: '',
    toneLabel: 'neutral',
    items: [{ locationId: 'loc_1', portions }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.order.findMany.mockResolvedValue([])
  mockPrisma.clientMealConfig.update.mockResolvedValue({})
  mockPrisma.activityLog.create.mockResolvedValue({})
  mockSetPortions.mockResolvedValue({
    ok: true,
    kind: 'updated',
    orderId: 'o',
    prevPortions: 33,
    prevStatus: 'CONFIRMED',
  })
  mockSend.mockResolvedValue(undefined)
  mockNotifyProd.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('isStickyClient', () => {
  it('только STICKY → да; есть DYNAMIC → нет', () => {
    expect(isStickyClient(makeClient())).toBe(true)
    expect(isStickyClient(makeClient({ orderType: 'DYNAMIC' }))).toBe(false)
  })
})

describe('handleStickyMessage', () => {
  it('число до cut-off (чт 12:00 МСК) → с завтра (пт), будущие заказы пересчитаны, конфиг обновлён', async () => {
    const now = new Date('2026-10-01T09:00:00.000Z')
    mockParse.mockResolvedValue(numeric(40))
    mockPrisma.order.findMany.mockResolvedValue([
      { id: 'o_fri', deliveryDate: new Date('2026-10-02T00:00:00.000Z') },
      { id: 'o_mon', deliveryDate: new Date('2026-10-05T00:00:00.000Z') },
    ])

    const r = await handleStickyMessage(makeClient(), '40', 'chat_1', now)

    expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientId: 'client_h',
          locationId: 'loc_1',
          mealType: 'LUNCH',
          deliveryDate: { gte: new Date('2026-10-02T00:00:00.000Z') },
          status: { in: ['DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED'] },
          updDocumentLink: { is: null },
        }),
      }),
    )
    expect(mockSetPortions).toHaveBeenCalledTimes(2)
    expect(mockSetPortions).toHaveBeenCalledWith(
      { id: 'admin_pro_1', role: 'ADMIN_PRO' },
      { orderId: 'o_fri', portions: 40, via: 'sticky' },
    )
    expect(mockPrisma.clientMealConfig.update).toHaveBeenCalledWith({
      where: { id: 'cfg_s' },
      data: { fixedPortions: 40 },
    })
    expect(r).toEqual({
      reply:
        'Принято! Теперь 40 порций каждый день, начиная с пт, 2 окт. Если нужно изменить — просто напишите новое число.',
      changed: true,
    })
    expect(mockSend).toHaveBeenCalledWith('chat_1', r!.reply)
    expect(mockNotifyProd).toHaveBeenCalledWith('🔁 ХАЛВА: теперь 40 порций с пт, 2 окт')
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'STICKY_PORTIONS_CHANGED',
        payload: expect.objectContaining({
          oldPortions: 33,
          newPortions: 40,
          effectiveFrom: '2026-10-02',
          ordersUpdated: 2,
        }),
      }),
    })
  })

  it('число после cut-off (чт 17:00 МСК) → с послезавтра; пятничный заказ не меняется', async () => {
    const now = new Date('2026-10-01T14:00:00.000Z')
    mockParse.mockResolvedValue(numeric(40))

    await handleStickyMessage(makeClient(), '40', 'chat_1', now)

    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-03T00:00:00.000Z'),
    })
    // в сб по WEEKDAYS доставки нет — клиенту называем первый рабочий день
    expect(mockSend.mock.calls[0][1]).toContain('начиная с пн, 5 окт')
  })

  it('то же число → «так и оставляем», ничего не меняем и производство не дёргаем', async () => {
    mockParse.mockResolvedValue(numeric(33))

    const r = await handleStickyMessage(makeClient(), '33', 'chat_1', new Date('2026-10-01T09:00:00.000Z'))

    expect(r).toEqual({ reply: 'Да, 33 порций — так и оставляем 👍', changed: false })
    expect(mockSetPortions).not.toHaveBeenCalled()
    expect(mockPrisma.clientMealConfig.update).not.toHaveBeenCalled()
    expect(mockNotifyProd).not.toHaveBeenCalled()
  })

  it('заказ с УПД не трогается: выборка исключает УПД, отказ Core не ломает остальное', async () => {
    mockParse.mockResolvedValue(numeric(40))
    mockPrisma.order.findMany.mockResolvedValue([
      { id: 'o_ok', deliveryDate: new Date('2026-10-02T00:00:00.000Z') },
      { id: 'o_upd', deliveryDate: new Date('2026-10-05T00:00:00.000Z') },
    ])
    mockSetPortions
      .mockResolvedValueOnce({ ok: true, kind: 'updated', orderId: 'o_ok', prevPortions: 33, prevStatus: 'CONFIRMED' })
      .mockResolvedValueOnce({ ok: false, skipped: true, reason: 'по заказу уже выписан УПД', orderId: 'o_upd' })

    const r = await handleStickyMessage(makeClient(), '40', 'chat_1', new Date('2026-10-01T09:00:00.000Z'))

    expect(r?.changed).toBe(true)
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.updDocumentLink).toEqual({ is: null })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data.payload).toMatchObject({
      ordersUpdated: 1,
      ordersFailed: [{ orderId: 'o_upd', reason: 'по заказу уже выписан УПД' }],
    })
  })

  it('без числа / с датой / с 0 → не STICKY (spontaneous-ветка)', async () => {
    expect(await handleStickyMessage(makeClient(), 'а что сегодня в меню?', 'c')).toBeNull()
    expect(await handleStickyMessage(makeClient(), 'в пятницу 20', 'c')).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()

    mockParse.mockResolvedValue(numeric(0))
    expect(await handleStickyMessage(makeClient(), '0', 'c')).toBeNull()
    mockParse.mockResolvedValue({ ...numeric(1), type: 'question', items: [] })
    expect(await handleStickyMessage(makeClient(), 'нас 2 офиса?', 'c')).toBeNull()
    expect(mockLog).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('generateFixedOrdersForRange — STICKY как FIXED', () => {
  it('STICKY-конфиг попадает в выборку и генерирует CONFIRMED-заказы с fixedPortions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T03:00:00.000Z')) // чт 06:00 МСК
    mockPrisma.clientMealConfig.findMany.mockResolvedValue([
      {
        ...STICKY_CONFIG,
        pricePerPortion: 300,
        client: { id: 'client_h', isActive: true, defaultOurLegalEntityId: null, defaultOurLegalEntity: null },
        location: {
          id: 'loc_1',
          isActive: true,
          packaging: 'INDIVIDUAL',
          sameDayDelivery: false,
          cutoffHourMsk: null,
          cutoffMinuteMsk: null,
        },
      },
    ])
    mockPrisma.order.findMany.mockResolvedValue([])
    mockPrisma.order.createMany.mockResolvedValue({ count: 5 })

    await generateFixedOrdersForRange(new Date('2026-10-02T00:00:00.000Z'), 7, { triggeredByUserId: null })

    expect(mockPrisma.clientMealConfig.findMany.mock.calls[0][0].where.orderType).toEqual({
      in: ['FIXED', 'DYNAMIC', 'STICKY'],
    })
    const rows = mockPrisma.order.createMany.mock.calls[0][0].data
    // 7 дней вперёд, WEEKDAYS → 5 заказов (пт, пн–чт)
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row).toMatchObject({ portions: 33, status: 'CONFIRMED', source: 'FIXED_AUTO' })
    }
  })
})

describe('handleStickyMessage — «добавьте / уберите» (07.10)', () => {
  function delta(portions: number) {
    return { ...numeric(portions), items: [{ locationId: 'loc_1', portions, mode: 'add' }] }
  }

  it('постоянно 33, «добавьте 2» → теперь 35 и заказы пересчитаны', async () => {
    mockParse.mockResolvedValue(delta(2))
    mockPrisma.order.findMany.mockResolvedValue([{ id: 'o_fri', deliveryDate: new Date('2026-10-02T00:00:00.000Z') }])

    const r = await handleStickyMessage(makeClient(), 'добавьте 2', 'chat_1', new Date('2026-10-01T09:00:00.000Z'))

    expect(mockSetPortions).toHaveBeenCalledWith(expect.anything(), { orderId: 'o_fri', portions: 35, via: 'sticky' })
    expect(mockPrisma.clientMealConfig.update).toHaveBeenCalledWith({ where: { id: 'cfg_s' }, data: { fixedPortions: 35 } })
    expect(r?.reply).toContain('Теперь 35 порций')
  })

  it('«уберите одну» (число словом) → 32', async () => {
    mockParse.mockResolvedValue(delta(-1))
    const r = await handleStickyMessage(makeClient(), 'уберите одну', 'chat_1', new Date('2026-10-01T09:00:00.000Z'))
    expect(mockParse).toHaveBeenCalled()
    expect(r?.reply).toContain('Теперь 32 порций')
  })

  it('убрать больше, чем стоит (33 − 40) → не STICKY, отдаём менеджеру', async () => {
    mockParse.mockResolvedValue(delta(-40))
    expect(await handleStickyMessage(makeClient(), 'уберите 40', 'chat_1', new Date('2026-10-01T09:00:00.000Z'))).toBeNull()
    expect(mockSetPortions).not.toHaveBeenCalled()
  })
})

describe('handleStickyMessage — период не становится новой постоянной', () => {
  it('«с 7 по 14 +1» → null (уходит в изменение на период), LLM не зовём', async () => {
    expect(await handleStickyMessage(makeClient(), 'с 7 по 14 +1', 'c')).toBeNull()
    expect(await handleStickyMessage(makeClient(), 'всю следующую неделю по 30', 'c')).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()
  })
})
