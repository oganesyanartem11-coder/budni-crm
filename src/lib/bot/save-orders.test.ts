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
  })

  it('LOCKED, portions 25, клиент шлёт 30 → status НЕ понижается, portions=30, 1 savedItem', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      portions: 25,
      status: 'LOCKED',
    })

    const res = await saveBotOrders(makeInput(30))

    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.portions).toBe(30)
    // LOCKED не понижается до PENDING и не повышается до CONFIRMED
    expect(data.status).toBeUndefined()
    expect(res.savedItems).toHaveLength(1)
  })
})
