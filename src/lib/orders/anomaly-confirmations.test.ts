import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPrisma, mockCreateCore, mockCreateInbox, mockSetPortions } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    pendingAnomalyConfirmation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    clientPortionBaseline: { upsert: vi.fn() },
    botConversation: { updateMany: vi.fn() },
    inboxItem: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
  },
  mockCreateCore: vi.fn(),
  mockCreateInbox: vi.fn(),
  mockSetPortions: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/app/(app)/orders/actions', () => ({ createOneTimeOrderCore: mockCreateCore }))
vi.mock('@/lib/bot/create-inbox-item', () => ({ createInboxItem: mockCreateInbox }))
vi.mock('@/lib/orders/client-portions', () => ({ setOrderPortionsForClient: mockSetPortions }))

import {
  confirmPendingAnomaly,
  createOrReusePendingAnomalyConfirmation,
  rejectPendingAnomaly,
} from './anomaly-confirmations'

const NOW = new Date('2026-08-06T10:00:00.000Z')
const DELIVERY = new Date('2026-08-07T00:00:00.000Z')
// Заказ сгенерирован ДО запроса аномалии (cron 06:00).
const GENERATED_AT = new Date('2026-08-06T03:00:00.000Z')
const pending = {
  id: 'anom_1',
  clientId: 'client_1',
  locationId: 'loc_1',
  mealType: 'LUNCH',
  deliveryDate: DELIVERY,
  proposedPortions: 5,
  status: 'PENDING',
  processingAt: null,
  conversationId: 'conv_1',
  createdAt: new Date('2026-08-06T09:00:00.000Z'),
  client: { id: 'client_1', name: 'Клиент' },
  location: { id: 'loc_1', name: 'Офис' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockPrisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma),
  )
  mockPrisma.pendingAnomalyConfirmation.findFirst.mockResolvedValue(null)
  mockPrisma.pendingAnomalyConfirmation.create.mockResolvedValue(pending)
  mockPrisma.pendingAnomalyConfirmation.findUnique.mockResolvedValue(pending)
  mockPrisma.pendingAnomalyConfirmation.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.clientPortionBaseline.upsert.mockResolvedValue({})
  mockPrisma.botConversation.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.inboxItem.findFirst.mockResolvedValue(null)
  mockPrisma.order.findFirst.mockResolvedValue(null)
  mockCreateCore.mockResolvedValue({ ok: true, data: { orderId: 'order_1' } })
  mockCreateInbox.mockResolvedValue({ id: 'inbox_1' })
  mockSetPortions.mockResolvedValue({
    ok: true,
    kind: 'confirmed',
    orderId: 'order_existing',
    prevPortions: 0,
    prevStatus: 'PENDING_CONFIRMATION',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createOrReusePendingAnomalyConfirmation', () => {
  it('создаёт PENDING с точной conversationId', async () => {
    const result = await createOrReusePendingAnomalyConfirmation({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      proposedPortions: 5,
      conversationId: 'conv_1',
    })

    expect(result).toEqual({ confirmation: pending, reused: false })
    expect(mockPrisma.pendingAnomalyConfirmation.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client_1',
        locationId: 'loc_1',
        mealType: 'LUNCH',
        deliveryDate: DELIVERY,
        proposedPortions: 5,
        conversationId: 'conv_1',
      },
    })
  })

  it('при reuse безопасно заполняет только пустую conversationId', async () => {
    mockPrisma.pendingAnomalyConfirmation.findFirst.mockResolvedValue({
      ...pending,
      conversationId: null,
    })

    const result = await createOrReusePendingAnomalyConfirmation({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      proposedPortions: 5,
      conversationId: 'conv_current',
    })

    expect(result.confirmation.conversationId).toBe('conv_current')
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany).toHaveBeenCalledWith({
      where: { id: 'anom_1', status: 'PENDING', conversationId: null },
      data: { conversationId: 'conv_current' },
    })
    expect(mockPrisma.pendingAnomalyConfirmation.create).not.toHaveBeenCalled()
  })

  it('при reuse не перезаписывает чужую conversationId', async () => {
    mockPrisma.pendingAnomalyConfirmation.findFirst.mockResolvedValue({
      ...pending,
      conversationId: 'conv_original',
    })

    const result = await createOrReusePendingAnomalyConfirmation({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      proposedPortions: 5,
      conversationId: 'conv_other',
    })

    expect(result.confirmation.conversationId).toBe('conv_original')
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany).not.toHaveBeenCalled()
  })

  it('повторяет serializable-транзакцию после конкурентного P2034', async () => {
    mockPrisma.$transaction
      .mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }))
      .mockImplementationOnce(
        async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma),
      )

    const result = await createOrReusePendingAnomalyConfirmation({
      clientId: 'client_1',
      locationId: 'loc_1',
      mealType: 'LUNCH',
      deliveryDate: DELIVERY,
      proposedPortions: 5,
      conversationId: 'conv_1',
    })

    expect(result.reused).toBe(false)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })
})

describe('confirmPendingAnomaly — PROCESSING state machine', () => {
  it('передаёт в Order ровно mealType конкретного pending', async () => {
    mockPrisma.pendingAnomalyConfirmation.findUnique.mockResolvedValue({
      ...pending,
      mealType: 'DINNER',
    })

    await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(mockCreateCore).toHaveBeenCalledWith(
      { id: 'manager_1', role: 'MANAGER' },
      expect.objectContaining({ mealType: 'DINNER' }),
    )
  })

  it('claim PROCESSING → Core → baseline → CONFIRMED и завершает только связанную conversation', async () => {
    mockPrisma.pendingAnomalyConfirmation.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'CONFIRMED' })

    const first = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })
    const second = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(first).toEqual({ ok: true, orderId: 'order_1', portions: 5 })
    expect(second).toEqual({ ok: false, reason: 'already_processed' })
    expect(mockCreateCore).toHaveBeenCalledOnce()
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'anom_1', status: 'PENDING' },
      data: { status: 'PROCESSING', processingAt: NOW },
    })
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'anom_1', status: 'PROCESSING' },
      data: {
        status: 'CONFIRMED',
        processingAt: null,
        resolvedAt: NOW,
        resolvedById: 'manager_1',
      },
    })
    expect(mockPrisma.botConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv_1', clientId: 'client_1' },
      data: { status: 'CONFIRMED' },
    })
  })

  it('свежий PROCESSING возвращает already_processing без Core', async () => {
    mockPrisma.pendingAnomalyConfirmation.findUnique.mockResolvedValue({
      ...pending,
      status: 'PROCESSING',
      processingAt: new Date(NOW.getTime() - 30_000),
    })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(result).toEqual({ ok: false, reason: 'already_processing' })
    expect(mockCreateCore).not.toHaveBeenCalled()
    expect(mockPrisma.order.findFirst).not.toHaveBeenCalled()
  })

  it('stale PROCESSING с существующим Order доводит его порции и завершает recovery без create', async () => {
    mockPrisma.pendingAnomalyConfirmation.findUnique.mockResolvedValue({
      ...pending,
      status: 'PROCESSING',
      processingAt: new Date(NOW.getTime() - 3 * 60_000),
    })
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_existing', updatedAt: GENERATED_AT })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'admin_1', role: 'ADMIN' },
    })

    expect(result).toEqual({
      ok: true,
      orderId: 'order_existing',
      portions: 5,
      recovered: true,
    })
    expect(mockCreateCore).not.toHaveBeenCalled()
    expect(mockSetPortions).toHaveBeenCalledWith(
      { id: 'admin_1', role: 'ADMIN' },
      { orderId: 'order_existing', portions: 5, via: 'anomaly_confirmation' },
    )
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        clientId: 'client_1',
        locationId: 'loc_1',
        mealType: 'LUNCH',
        deliveryDate: DELIVERY,
        status: { not: 'CANCELLED' },
      },
      select: { id: true, updatedAt: true },
    })
    expect(mockPrisma.clientPortionBaseline.upsert).toHaveBeenCalled()
  })

  it('stale PROCESSING без Order освобождает PENDING и делает один новый claim', async () => {
    const staleAt = new Date(NOW.getTime() - 3 * 60_000)
    mockPrisma.pendingAnomalyConfirmation.findUnique.mockResolvedValue({
      ...pending,
      status: 'PROCESSING',
      processingAt: staleAt,
    })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(result.ok).toBe(true)
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'anom_1', status: 'PROCESSING', processingAt: staleAt },
      data: { status: 'PENDING', processingAt: null },
    })
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'anom_1', status: 'PENDING' },
      data: { status: 'PROCESSING', processingAt: NOW },
    })
    expect(mockCreateCore).toHaveBeenCalledOnce()
  })

  it('business error освобождает PROCESSING в PENDING без baseline', async () => {
    mockCreateCore.mockResolvedValue({ ok: false, error: 'Не удалось определить цену' })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'admin_1', role: 'ADMIN' },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'core_error',
      error: 'Не удалось определить цену',
    })
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'anom_1', status: 'PROCESSING', processingAt: NOW },
      data: { status: 'PENDING', processingAt: null, resolvedAt: null, resolvedById: null },
    })
    expect(mockPrisma.clientPortionBaseline.upsert).not.toHaveBeenCalled()
  })

  it('exception после фактического Order завершает recovery и не возвращает PENDING', async () => {
    mockCreateCore.mockRejectedValue(new Error('activity log failed'))
    // До create заказа нет (preexisting-проверка), после исключения — уже есть.
    mockPrisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'order_after_exception' })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'admin_pro_1', role: 'ADMIN_PRO' },
    })

    expect(result).toEqual({
      ok: true,
      orderId: 'order_after_exception',
      portions: 5,
      recovered: true,
    })
    const updates = mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls.map((call) => call[0])
    expect(updates).not.toContainEqual(expect.objectContaining({ data: { status: 'PENDING' } }))
  })

  it('«Да» по дате, где заказ уже сгенерирован (DYNAMIC/FIXED): обновляет его порции, create не зовёт', async () => {
    // Баг старых кнопок: createOneTimeOrderCore отказывал «На эту дату уже есть заказ».
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_generated', updatedAt: GENERATED_AT })
    mockSetPortions.mockResolvedValue({
      ok: true,
      kind: 'confirmed',
      orderId: 'order_generated',
      prevPortions: 0,
      prevStatus: 'PENDING_CONFIRMATION',
    })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(result).toEqual({ ok: true, orderId: 'order_generated', portions: 5 })
    expect(mockCreateCore).not.toHaveBeenCalled()
    expect(mockSetPortions).toHaveBeenCalledWith(
      { id: 'manager_1', role: 'MANAGER' },
      { orderId: 'order_generated', portions: 5, via: 'anomaly_confirmation' },
    )
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }),
    )
  })

  it('старое «Да» не затирает число, принятое ПОСЛЕ запроса (заказ менялся позже)', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'order_newer',
      updatedAt: new Date('2026-08-06T09:30:00.000Z'),
    })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'core_error',
      error: 'заказ изменён после этого запроса — число не применяем, проверьте заказ',
    })
    expect(mockSetPortions).not.toHaveBeenCalled()
    expect(mockCreateCore).not.toHaveBeenCalled()
  })

  it('«Да» по заказу с УПД: порции не меняет, подтверждение возвращается в PENDING с причиной', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ id: 'order_upd', updatedAt: GENERATED_AT })
    mockSetPortions.mockResolvedValue({
      ok: false,
      skipped: true,
      reason: 'по заказу уже выписан УПД',
      orderId: 'order_upd',
    })

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'admin_1', role: 'ADMIN' },
    })

    expect(result).toEqual({ ok: false, reason: 'core_error', error: 'по заказу уже выписан УПД' })
    expect(mockCreateCore).not.toHaveBeenCalled()
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0].data)
      .toEqual({ status: 'PENDING', processingAt: null, resolvedAt: null, resolvedById: null })
  })

  it('exception без Order освобождает PROCESSING и возвращает читаемую ошибку', async () => {
    mockCreateCore.mockRejectedValue(new Error('database unavailable'))

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'admin_1', role: 'ADMIN' },
    })

    expect(result).toEqual({ ok: false, reason: 'core_error', error: 'database unavailable' })
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0].data)
      .toEqual({ status: 'PENDING', processingAt: null, resolvedAt: null, resolvedById: null })
  })

  it('baseline failure оставляет Order/confirmation CONFIRMED и сообщает частичный успех', async () => {
    mockPrisma.clientPortionBaseline.upsert.mockRejectedValue(new Error('baseline unavailable'))

    const result = await confirmPendingAnomaly({
      confirmationId: 'anom_1',
      user: { id: 'manager_1', role: 'MANAGER' },
    })

    expect(result).toEqual({
      ok: false,
      reason: 'baseline_error',
      error: 'baseline unavailable',
      orderId: 'order_1',
    })
    expect(mockPrisma.pendingAnomalyConfirmation.updateMany.mock.calls[1][0].data)
      .toEqual({
        status: 'CONFIRMED',
        processingAt: null,
        resolvedAt: NOW,
        resolvedById: 'manager_1',
      })
    expect(mockPrisma.botConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv_1', clientId: 'client_1' },
      data: { status: 'CONFIRMED' },
    })
  })
})

describe('rejectPendingAnomaly', () => {
  it('ставит REJECTED, создаёт один InboxItem и не завершает conversation', async () => {
    mockPrisma.pendingAnomalyConfirmation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    const first = await rejectPendingAnomaly({ confirmationId: 'anom_1', userId: 'manager_1' })
    const second = await rejectPendingAnomaly({ confirmationId: 'anom_1', userId: 'manager_1' })

    expect(first).toEqual({ ok: true, inboxItemId: 'inbox_1' })
    expect(second).toEqual({ ok: false, reason: 'already_processed' })
    expect(mockCreateInbox).toHaveBeenCalledOnce()
    expect(mockCreateInbox).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv_1' }),
    )
    expect(mockPrisma.botConversation.updateMany).not.toHaveBeenCalled()
  })
})
