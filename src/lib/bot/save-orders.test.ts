import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * П3: ответ клиента подтверждает заказ.
 *
 * Когда клиент отвечает, saveBotOrders обновляет существующий заказ. Раньше он
 * трогал только portions, оставляя status=PENDING_CONFIRMATION — из-за чего
 * производственные доски показывали «не ответили / нет данных», хотя порции
 * заполнены. Теперь существующий заказ в PENDING_CONFIRMATION переводится в
 * CONFIRMED (с проставлением confirmedAt).
 *
 * GUARD: разрешён ТОЛЬКО переход PENDING_CONFIRMATION → CONFIRMED. Любой иной
 * статус (CONFIRMED/LOCKED/IN_PRODUCTION/OUT_FOR_DELIVERY/DELIVERED) НИКОГДА
 * не понижается; для них status не трогается, обновляются только порции.
 *
 * Prisma мокаем целиком; snapshot юрлица — заглушка.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    clientLocation: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/orders/legal-entity-snapshot', () => ({
  getOrderLegalEntitySnapshot: vi
    .fn()
    .mockResolvedValue({ ourLegalEntityId: 'le_1', vatRate: '0' }),
}))

import { saveBotOrders } from './save-orders'
import type { SaveBotOrdersInput } from './save-orders'

const DELIVERY_DATE = new Date('2026-06-05T00:00:00.000Z')

function makeInput(portions: number): SaveBotOrdersInput {
  return {
    clientId: 'client_1',
    conversationId: 'conv_1',
    deliveryDate: DELIVERY_DATE,
    items: [{ locationId: 'loc_1', portions }],
    activeMealConfigsByLocation: {
      loc_1: [{ mealType: 'LUNCH', pricePerPortion: 300, locationName: 'Офис' }],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.order.update.mockResolvedValue({})
  mockPrisma.order.create.mockResolvedValue({})
  mockPrisma.clientLocation.findUnique.mockResolvedValue({ packaging: null, tags: [] })
})

describe('saveBotOrders — П3 status bump', () => {
  it('PENDING_CONFIRMATION, portions 0, клиент отвечает 25 → CONFIRMED, portions=25, 1 savedItem', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 0,
      status: 'PENDING_CONFIRMATION',
    })

    const res = await saveBotOrders(makeInput(25))

    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.portions).toBe(25)
    expect(data.totalPrice).toBe(300 * 25)
    expect(data.status).toBe('CONFIRMED')
    expect(data.confirmedAt).toBeInstanceOf(Date)
    expect(res.savedItems).toHaveLength(1)
    expect(res.wasUpdate).toBe(true)
  })

  it('PENDING_CONFIRMATION, portions 25, клиент повторяет 25 (status-bump only) → CONFIRMED, 1 savedItem', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 25,
      status: 'PENDING_CONFIRMATION',
    })

    const res = await saveBotOrders(makeInput(25))

    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.status).toBe('CONFIRMED')
    expect(data.portions).toBe(25)
    expect(res.savedItems).toHaveLength(1)
  })

  it('CONFIRMED, portions 25, клиент повторяет 25 → без update, savedItems пуст', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 25,
      status: 'CONFIRMED',
    })

    const res = await saveBotOrders(makeInput(25))

    expect(mockPrisma.order.update).not.toHaveBeenCalled()
    expect(res.savedItems).toHaveLength(0)
    expect(res.wasUpdate).toBe(false)
  })

  it('CONFIRMED, portions 25, клиент шлёт 30 → portions=30, status остаётся CONFIRMED (не трогается), 1 savedItem', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 25,
      status: 'CONFIRMED',
    })

    const res = await saveBotOrders(makeInput(30))

    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.portions).toBe(30)
    // status не выставляется (нет bump из PENDING_CONFIRMATION)
    expect(data.status).toBeUndefined()
    expect(data.confirmedAt).toBeUndefined()
    expect(res.savedItems).toHaveLength(1)
    // F3: update-ветка возвращает старое значение порций для notify производства.
    expect(res.savedItems[0].wasUpdate).toBe(true)
    expect(res.savedItems[0].previousPortions).toBe(25)
  })

  it('F3: новый заказ (create-ветка) → previousPortions undefined, wasUpdate=false', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)

    const res = await saveBotOrders(makeInput(40))

    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1)
    expect(res.savedItems).toHaveLength(1)
    expect(res.savedItems[0].wasUpdate).toBe(false)
    expect(res.savedItems[0].previousPortions).toBeUndefined()
  })

  it('LOCKED (кухня уже готовит), клиент шлёт 30 → заказ не трогаем, менеджеру причина', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_1', portions: 25, status: 'LOCKED' })

    const res = await saveBotOrders(makeInput(30))

    expect(mockPrisma.order.update).not.toHaveBeenCalled()
    expect(res.savedItems).toHaveLength(0)
    expect(res.unmatchedItems[0].reason).toBe('заказ уже в работе у кухни')
  })

  it('по заказу выписан УПД → не трогаем', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 25,
      status: 'CONFIRMED',
      updDocumentLink: { id: 'upd_1' },
    })
    const res = await saveBotOrders(makeInput(30))
    expect(mockPrisma.order.update).not.toHaveBeenCalled()
    expect(res.unmatchedItems[0].reason).toBe('по заказу уже выписан УПД')
  })
})

describe('saveBotOrders — приём пищи из ответа (баг 06.10, «Идеология Еды»)', () => {
  const THREE_MEALS: SaveBotOrdersInput['activeMealConfigsByLocation'] = {
    loc_1: [
      { mealType: 'BREAKFAST', pricePerPortion: 200, locationName: 'Повадино' },
      { mealType: 'LUNCH', pricePerPortion: 300, locationName: 'Повадино' },
      { mealType: 'DINNER', pricePerPortion: 250, locationName: 'Повадино' },
    ],
  }

  it('«Обед 75, завтрак и ужин 45» → обед 75, завтрак 45, ужин 45 (а не всё по 45)', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)

    const r = await saveBotOrders({
      clientId: 'client_1',
      conversationId: 'conv_1',
      deliveryDate: DELIVERY_DATE,
      items: [
        { locationId: 'loc_1', portions: 75, mealType: 'LUNCH' },
        { locationId: 'loc_1', portions: 45, mealType: 'BREAKFAST' },
        { locationId: 'loc_1', portions: 45, mealType: 'DINNER' },
      ],
      activeMealConfigsByLocation: THREE_MEALS,
    })

    const created = mockPrisma.order.create.mock.calls.map((c) => [c[0].data.mealType, c[0].data.portions])
    expect(created).toEqual([
      ['LUNCH', 75],
      ['BREAKFAST', 45],
      ['DINNER', 45],
    ])
    expect(r.savedItems).toHaveLength(3)
    expect(r.unmatchedItems).toEqual([])
  })

  it('число без приёма пищи → все приёмы точки, кроме названных явно', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)

    await saveBotOrders({
      clientId: 'client_1',
      conversationId: 'conv_1',
      deliveryDate: DELIVERY_DATE,
      items: [
        { locationId: 'loc_1', portions: 30 },
        { locationId: 'loc_1', portions: 10, mealType: 'DINNER' },
      ],
      activeMealConfigsByLocation: THREE_MEALS,
    })

    const created = mockPrisma.order.create.mock.calls.map((c) => [c[0].data.mealType, c[0].data.portions])
    expect(created).toEqual([
      ['BREAKFAST', 30],
      ['LUNCH', 30],
      ['DINNER', 10],
    ])
  })

  it('приём пищи, которого у точки нет → ничего не создаём, строка в unmatchedItems', async () => {
    const r = await saveBotOrders({ ...makeInput(20), items: [{ locationId: 'loc_1', portions: 20, mealType: 'DINNER' }] })
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(r.unmatchedItems).toEqual([
      { locationId: 'loc_1', mealType: 'DINNER', portions: 20, reason: 'у точки нет такого приёма пищи' },
    ])
  })
})

describe('saveBotOrders — «добавьте / уберите» (mode=add, 07.10)', () => {
  it('заказ 34 + «добавьте 1» → 35', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', portions: 34, status: 'CONFIRMED' })
    const r = await saveBotOrders({ ...makeInput(1), items: [{ locationId: 'loc_1', portions: 1, mode: 'add' }] })
    expect(mockPrisma.order.update.mock.calls[0][0].data).toMatchObject({ portions: 35, totalPrice: 300 * 35 })
    expect(r.savedItems[0]).toMatchObject({ portions: 35, previousPortions: 34 })
  })

  it('заказ 10 + «на 3 меньше» → 7', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', portions: 10, status: 'CONFIRMED' })
    await saveBotOrders({ ...makeInput(-3), items: [{ locationId: 'loc_1', portions: -3, mode: 'add' }] })
    expect(mockPrisma.order.update.mock.calls[0][0].data.portions).toBe(7)
  })

  it('заказа нет / он ещё без ответа (0 в PENDING) → не создаём «1», а unmatched', async () => {
    mockPrisma.order.findFirst.mockResolvedValueOnce(null)
    const r1 = await saveBotOrders({ ...makeInput(1), items: [{ locationId: 'loc_1', portions: 1, mode: 'add' }] })
    mockPrisma.order.findFirst.mockResolvedValueOnce({ id: 'o1', portions: 0, status: 'PENDING_CONFIRMATION' })
    const r2 = await saveBotOrders({ ...makeInput(1), items: [{ locationId: 'loc_1', portions: 1, mode: 'add' }] })
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(mockPrisma.order.update).not.toHaveBeenCalled()
    expect(r1.unmatchedItems[0].reason).toContain('не к чему прибавить')
    expect(r2.unmatchedItems[0].reason).toContain('не к чему прибавить')
  })

  it('убрать больше, чем заказано → unmatched, заказ не трогаем', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'o1', portions: 3, status: 'CONFIRMED' })
    const r = await saveBotOrders({ ...makeInput(-5), items: [{ locationId: 'loc_1', portions: -5, mode: 'add' }] })
    expect(mockPrisma.order.update).not.toHaveBeenCalled()
    expect(r.unmatchedItems[0].reason).toBe('в заказе 3, убрать 5 нельзя')
  })

  it('«добавьте 1» без приёма пищи при завтраке/обеде/ужине → unmatched (непонятно к чему)', async () => {
    const r = await saveBotOrders({
      ...makeInput(1),
      items: [{ locationId: 'loc_1', portions: 1, mode: 'add' }],
      activeMealConfigsByLocation: {
        loc_1: [
          { mealType: 'BREAKFAST', pricePerPortion: 200, locationName: 'Офис' },
          { mealType: 'LUNCH', pricePerPortion: 300, locationName: 'Офис' },
        ],
      },
    })
    expect(mockPrisma.order.findFirst).not.toHaveBeenCalled()
    expect(r.unmatchedItems[0].reason).toBe('непонятно, к какому приёму пищи прибавить')
  })
})


describe('saveBotOrders — аудит 08.10', () => {
  it('«25» без приёма пищи: DYNAMIC-обед 25, FIXED-завтрак (10) не трогаем', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)
    await saveBotOrders({
      ...makeInput(25),
      activeMealConfigsByLocation: {
        loc_1: [
          { mealType: 'BREAKFAST', pricePerPortion: 200, locationName: 'Офис', orderType: 'FIXED' },
          { mealType: 'LUNCH', pricePerPortion: 300, locationName: 'Офис', orderType: 'DYNAMIC' },
        ],
      },
    })
    expect(mockPrisma.order.create.mock.calls.map((c) => c[0].data.mealType)).toEqual(['LUNCH'])
  })

  it('два разных числа на один заказ («завтра 15, послезавтра 20» с одной датой) → не выбираем молча', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null)
    const r = await saveBotOrders({
      ...makeInput(15),
      items: [
        { locationId: 'loc_1', portions: 15 },
        { locationId: 'loc_1', portions: 20 },
      ],
    })
    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1)
    expect(r.unmatchedItems[0].reason).toBe('в сообщении два разных числа для одного приёма пищи')
  })

  it('чужая/неизвестная точка → unmatched, а не «Принято» без заказа', async () => {
    const r = await saveBotOrders({ ...makeInput(5), items: [{ locationId: 'loc_x', portions: 5 }] })
    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(r.unmatchedItems[0].reason).toBe('у клиента нет такой точки или на ней нет питания')
  })
})
