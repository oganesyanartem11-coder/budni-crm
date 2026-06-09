import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Юнит-тесты жизненного цикла PendingOrderChange. Мокаем:
 *  - prisma.pendingOrderChange (create/updateMany/findUnique/findMany/update)
 *  - findActiveOrder из queries/orders (перепроверка заказа при EDIT)
 *  - editOrderPortionsCore / createOneTimeOrderCore из orders/actions
 *
 * Атомарный claim моделируем через updateMany → {count:1} (happy) /
 * {count:0} (already/expired). Время фиксируем фейк-таймерами.
 */

const { mockPrisma, mockFindActiveOrder, mockEditCore, mockCreateCore } = vi.hoisted(() => ({
  mockPrisma: {
    pendingOrderChange: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockFindActiveOrder: vi.fn(),
  mockEditCore: vi.fn(),
  mockCreateCore: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
// 7.55: confirm/reject/expire резолвят активного пользователя через
// getActiveMaxChatIdForClient; при null падают на sourceMaxChatId (снимок/fallback).
// По умолчанию возвращаем null → существующие ассерты на sourceMaxChatId сохраняются.
vi.mock('@/lib/bot/max-users', () => ({
  getActiveMaxChatIdForClient: vi.fn(async () => null),
}))
vi.mock('@/lib/db/queries/orders', () => ({ findActiveOrder: mockFindActiveOrder }))
vi.mock('@/app/(app)/orders/actions', () => ({
  editOrderPortionsCore: mockEditCore,
  createOneTimeOrderCore: mockCreateCore,
}))

import {
  createPendingChange,
  confirmPendingChange,
  rejectPendingChange,
  expirePendingChanges,
  EXPIRED_REPLY,
} from './actions'

const NOW = new Date('2026-06-04T10:00:00.000Z')
const DELIVERY = new Date('2026-06-05T00:00:00.000Z') // 05.06

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockPrisma.pendingOrderChange.update.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createPendingChange', () => {
  it('создаёт PENDING с expiresAt ≈ now+30 мин', async () => {
    mockPrisma.pendingOrderChange.create.mockResolvedValue({
      id: 'poc_1',
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    })

    const res = await createPendingChange({
      clientId: 'c1',
      locationId: 'L1',
      deliveryDate: DELIVERY,
      mealType: 'LUNCH',
      action: 'EDIT',
      proposedPortions: 12,
      currentOrderId: 'o1',
      currentPortions: 10,
      sourceMaxChatId: '999',
      rawClientMessage: 'давай 12',
      parsedConfidence: 0.9,
    })

    expect(res.id).toBe('poc_1')
    const createArg = mockPrisma.pendingOrderChange.create.mock.calls[0][0]
    expect(createArg.data.expiresAt.getTime()).toBe(NOW.getTime() + 30 * 60_000)
    // status не передаём — default PENDING.
    expect(createArg.data.status).toBeUndefined()
  })
})

describe('confirmPendingChange — EDIT happy', () => {
  it('claim → editCore ok → EXECUTED, replyText содержит порции + DD.MM', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      id: 'poc_1',
      clientId: 'c1',
      locationId: 'L1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      action: 'EDIT',
      proposedPortions: 12,
      currentOrderId: 'o1',
      sourceMaxChatId: '999',
    })
    mockFindActiveOrder.mockResolvedValue({
      id: 'o1',
      status: 'CONFIRMED',
      portions: 10,
      updatedAt: NOW,
    })
    mockEditCore.mockResolvedValue({ ok: true, data: { editedAfterLock: false } })

    const res = await confirmPendingChange({ changeId: 'poc_1', confirmedById: 'mgr1' })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.action).toBe('EDIT')
    expect(res.orderId).toBe('o1')
    expect(res.newPortions).toBe(12)
    expect(res.replyText).toContain('12')
    expect(res.replyText).toContain('05.06')
    expect(res.clientMaxChatId).toBe('999')

    // editCore вызван от лица ADMIN_PRO.
    expect(mockEditCore).toHaveBeenCalledWith(
      { id: 'mgr1', role: 'ADMIN_PRO' },
      { orderId: 'o1', portions: 12 },
    )
    // EXECUTED проставлен.
    const updates = mockPrisma.pendingOrderChange.update.mock.calls.map((c) => c[0].data.status)
    expect(updates).toContain('EXECUTED')
  })
})

describe('confirmPendingChange — CREATE happy', () => {
  it('claim → createCore ok → EXECUTED', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      id: 'poc_2',
      clientId: 'c1',
      locationId: 'L1',
      mealType: 'DINNER',
      deliveryDate: DELIVERY,
      action: 'CREATE',
      proposedPortions: 8,
      currentOrderId: null,
      sourceMaxChatId: '888',
    })
    mockCreateCore.mockResolvedValue({ ok: true, data: { orderId: 'new1' } })

    const res = await confirmPendingChange({ changeId: 'poc_2', confirmedById: 'mgr1' })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.action).toBe('CREATE')
    expect(res.orderId).toBe('new1')
    expect(res.replyText).toContain('8')
    expect(res.replyText).toContain('05.06')
    expect(mockCreateCore).toHaveBeenCalledWith(
      { id: 'mgr1', role: 'ADMIN_PRO' },
      {
        clientId: 'c1',
        locationId: 'L1',
        mealType: 'DINNER',
        deliveryDate: DELIVERY,
        portions: 8,
        source: 'CLIENT_REQUEST',
      },
    )
  })
})

describe('confirmPendingChange — expired', () => {
  it('claim count 0 + запись PENDING & expiresAt<now → expired', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      status: 'PENDING',
      expiresAt: new Date(NOW.getTime() - 60_000),
    })

    const res = await confirmPendingChange({ changeId: 'poc_x', confirmedById: 'mgr1' })
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('confirmPendingChange — already processed', () => {
  it('claim count 0 + запись не PENDING → already_processed', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      status: 'CONFIRMED',
      expiresAt: new Date(NOW.getTime() + 60_000),
    })

    const res = await confirmPendingChange({ changeId: 'poc_y', confirmedById: 'mgr1' })
    expect(res).toEqual({ ok: false, reason: 'already_processed' })
  })
})

describe('confirmPendingChange — EDIT order now LOCKED', () => {
  it('findActiveOrder вернул LOCKED → FAILED + order_now_locked', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      id: 'poc_3',
      clientId: 'c1',
      locationId: 'L1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      action: 'EDIT',
      proposedPortions: 15,
      currentOrderId: 'o1',
      sourceMaxChatId: '777',
    })
    mockFindActiveOrder.mockResolvedValue({
      id: 'o1',
      status: 'LOCKED',
      portions: 10,
      updatedAt: NOW,
    })

    const res = await confirmPendingChange({ changeId: 'poc_3', confirmedById: 'mgr1' })
    expect(res).toEqual({ ok: false, reason: 'order_now_locked' })
    expect(mockEditCore).not.toHaveBeenCalled()
    const updates = mockPrisma.pendingOrderChange.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ status: 'FAILED', failureReason: 'order_now_locked' })
  })
})

describe('confirmPendingChange — EDIT fallback to CREATE', () => {
  it('findActiveOrder=null → createCore вызван (auto-fallback)', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      id: 'poc_4',
      clientId: 'c1',
      locationId: 'L1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      action: 'EDIT',
      proposedPortions: 9,
      currentOrderId: 'o_gone',
      sourceMaxChatId: '666',
    })
    mockFindActiveOrder.mockResolvedValue(null)
    mockCreateCore.mockResolvedValue({ ok: true, data: { orderId: 'created1' } })

    const res = await confirmPendingChange({ changeId: 'poc_4', confirmedById: 'mgr1' })

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.action).toBe('CREATE')
    expect(res.orderId).toBe('created1')
    expect(mockEditCore).not.toHaveBeenCalled()
    expect(mockCreateCore).toHaveBeenCalledWith(
      { id: 'mgr1', role: 'ADMIN_PRO' },
      expect.objectContaining({ source: 'CLIENT_REQUEST', portions: 9 }),
    )
  })
})

describe('confirmPendingChange — CREATE menu/price failure', () => {
  it('createCore error содержит "цен" → menu_not_found', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      id: 'poc_5',
      clientId: 'c1',
      locationId: 'L1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      action: 'CREATE',
      proposedPortions: 5,
      currentOrderId: null,
      sourceMaxChatId: '555',
    })
    mockCreateCore.mockResolvedValue({
      ok: false,
      error: 'Не удалось определить цену — укажи pricePerPortion явно',
    })

    const res = await confirmPendingChange({ changeId: 'poc_5', confirmedById: 'mgr1' })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected fail')
    expect(res.reason).toBe('menu_not_found')
  })
})

describe('rejectPendingChange', () => {
  it('claim → REJECTED + postCutoffReplyText', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })
    // 7.53 F-A: select расширен (deliveryDate/locationId/client.locations) для
    // резолва персонального cut-off. Пустые locations → getClientCutoffForDate
    // падает на DEFAULT_CUTOFF (16:00), что и проверяет ассерт ниже.
    mockPrisma.pendingOrderChange.findUnique.mockResolvedValue({
      sourceMaxChatId: '444',
      deliveryDate: DELIVERY,
      locationId: 'L1',
      client: { locations: [] },
    })

    const res = await rejectPendingChange({ changeId: 'poc_6', confirmedById: 'mgr1' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.clientMaxChatId).toBe('444')
    expect(res.postCutoffReplyText).toContain('16:00')

    const updateArg = mockPrisma.pendingOrderChange.updateMany.mock.calls[0][0]
    expect(updateArg.data.status).toBe('REJECTED')
  })

  it('claim count 0 → already_processed', async () => {
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 0 })
    const res = await rejectPendingChange({ changeId: 'poc_7', confirmedById: 'mgr1' })
    expect(res).toEqual({ ok: false, reason: 'already_processed' })
  })
})

describe('expirePendingChanges', () => {
  it('помечает протухшие EXPIRED и возвращает список с EXPIRED_REPLY', async () => {
    mockPrisma.pendingOrderChange.findMany.mockResolvedValue([
      { id: 'e1', sourceMaxChatId: '111' },
      { id: 'e2', sourceMaxChatId: '222' },
    ])
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 1 })

    const res = await expirePendingChanges()
    expect(res.expired).toHaveLength(2)
    expect(res.expired[0]).toEqual({
      id: 'e1',
      clientMaxChatId: '111',
      postCutoffReplyText: EXPIRED_REPLY,
    })
    // updateMany выставляет EXPIRED.
    const arg = mockPrisma.pendingOrderChange.updateMany.mock.calls[0][0]
    expect(arg.data.status).toBe('EXPIRED')
  })

  it('гонка: claim count 0 → запись не попадает в результат', async () => {
    mockPrisma.pendingOrderChange.findMany.mockResolvedValue([
      { id: 'e1', sourceMaxChatId: '111' },
    ])
    mockPrisma.pendingOrderChange.updateMany.mockResolvedValue({ count: 0 })

    const res = await expirePendingChanges()
    expect(res.expired).toHaveLength(0)
  })
})
