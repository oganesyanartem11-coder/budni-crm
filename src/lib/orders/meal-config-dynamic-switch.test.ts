import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * FIXED/STICKY → DYNAMIC в карточке клиента (СтройБетонМонолит, 18.10): уже
 * сгенерированные FIXED-заказы остаются CONFIRMED со старым числом и блокируют
 * вопрос клиенту — клиенту поехало 20 обедов. Теперь будущие нетронутые клиентом
 * заказы возвращаются в «ждём ответа» (PENDING, 0), сегодняшний остаётся с
 * предупреждением менеджеру.
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    clientMealConfig: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    botConversation: { updateMany: vi.fn() },
    order: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateMealConfig } from '@/app/(app)/clients/actions'

const FORM = {
  locationId: 'loc_1',
  mealType: 'LUNCH' as const,
  orderType: 'DYNAMIC' as const,
  deliveryHorizon: 'NEXT_DAY' as const,
  scheduleType: 'DAILY' as const,
  scheduleData: null,
  fixedPortions: null,
  pricePerPortion: 300,
  validFrom: null,
  validTo: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T09:00:00.000Z')) // вс 12:00 МСК
  mockRequireRole.mockResolvedValue({ id: 'manager_1', role: 'MANAGER' })
  mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
    orderType: 'FIXED',
    fixedPortions: 20,
    clientId: 'client_s',
    scheduleType: 'DAILY',
    scheduleData: null,
    validFrom: null,
    validTo: null,
  })
  mockPrisma.clientMealConfig.update.mockResolvedValue({ clientId: 'client_s' })
  mockPrisma.order.findMany.mockResolvedValue([{ id: 'o_mon' }, { id: 'o_tue' }])
  mockPrisma.order.updateMany.mockResolvedValue({ count: 2 })
  mockPrisma.order.findFirst.mockResolvedValue({ portions: 20 })
})

describe('updateMealConfig: FIXED → DYNAMIC', () => {
  it('будущие нетронутые клиентом FIXED-заказы → PENDING/0; сегодняшний остаётся, менеджеру предупреждение', async () => {
    const r = await updateMealConfig('cfg_1', FORM)

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      sourceConfigId: 'cfg_1',
      status: 'CONFIRMED',
      sourceConversationId: null,
      updDocumentLink: { is: null },
      deliveryDate: { gte: new Date('2026-10-19T00:00:00.000Z') },
    })
    expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o_mon', 'o_tue'] } },
      data: { portions: 0, totalPrice: 0, status: 'PENDING_CONFIRMATION', confirmedAt: null },
    })
    expect(r).toEqual({
      ok: true,
      data: {
        note:
          'Заказы на будущие дни (2) вернули в «ждём ответа клиента». ' +
          'Заказ на сегодня (20 порций) создан по прежнему типу и остался — при необходимости поправьте вручную.',
      },
    })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data.payload).toMatchObject({
      oldOrderType: 'FIXED',
      newOrderType: 'DYNAMIC',
      resetToAsking: 2,
      todaysKept: 20,
    })
  })

  it('смена DYNAMIC → DYNAMIC или FIXED → FIXED заказы не трогает', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
      orderType: 'DYNAMIC', fixedPortions: null, clientId: 'client_s', scheduleType: 'DAILY', scheduleData: null, validFrom: null, validTo: null,
    })
    const r = await updateMealConfig('cfg_1', FORM)
    expect(r).toEqual({ ok: true, data: undefined })
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
  })
})

// 18.10: журнал правок питания — «кто поменял график/тип».
describe('updateMealConfig: журнал MEAL_CONFIG_UPDATED', () => {
  const EXISTING = {
    orderType: 'DYNAMIC',
    fixedPortions: null,
    clientId: 'client_s',
    scheduleType: 'CUSTOM_DAYS',
    scheduleData: { daysOfWeek: [1, 2, 3] },
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    pricePerPortion: new Prisma.Decimal(300),
    deliveryHorizon: 'NEXT_DAY',
    locationId: 'loc_1',
    mealType: 'LUNCH',
  }

  beforeEach(() => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(EXISTING)
  })

  it('пишет только реально изменившиеся поля; график без данных → scheduleData в БД = DbNull', async () => {
    const r = await updateMealConfig('cfg_1', { ...FORM, scheduleType: 'DAILY', pricePerPortion: 320 })

    expect(r).toEqual({ ok: true, data: undefined })
    expect(mockPrisma.clientMealConfig.update.mock.calls[0][0].data.scheduleData).toBe(Prisma.DbNull)
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toEqual({
      userId: 'manager_1',
      userRole: 'MANAGER',
      action: 'MEAL_CONFIG_UPDATED',
      entityType: 'ClientMealConfig',
      entityId: 'cfg_1',
      payload: {
        clientId: 'client_s',
        changes: {
          scheduleType: { from: 'CUSTOM_DAYS', to: 'DAILY' },
          scheduleData: { from: { daysOfWeek: [1, 2, 3] }, to: null },
          pricePerPortion: { from: 300, to: 320 },
        },
      },
    })
  })

  it('CUSTOM_DAYS с теми же днями и без правок — лога нет, scheduleData пишется как есть', async () => {
    await updateMealConfig('cfg_1', { ...FORM, scheduleType: 'CUSTOM_DAYS', scheduleData: { daysOfWeek: [1, 2, 3] } })
    expect(mockPrisma.clientMealConfig.update.mock.calls[0][0].data.scheduleData).toEqual({ daysOfWeek: [1, 2, 3] })
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled()
  })

  it('смена FIXED → DYNAMIC: правки полей в MEAL_CONFIG_TYPE_SWITCHED, без второго лога', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({ ...EXISTING, orderType: 'FIXED', fixedPortions: 20 })
    await updateMealConfig('cfg_1', { ...FORM, scheduleType: 'CUSTOM_DAYS', scheduleData: { daysOfWeek: [1, 2, 3] } })
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'MEAL_CONFIG_TYPE_SWITCHED',
      payload: {
        clientId: 'client_s',
        changes: { orderType: { from: 'FIXED', to: 'DYNAMIC' }, fixedPortions: { from: 20, to: null } },
      },
    })
  })

  it('сбой записи лога не роняет сохранение', async () => {
    mockPrisma.activityLog.create.mockRejectedValueOnce(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await updateMealConfig('cfg_1', { ...FORM, pricePerPortion: 350, scheduleType: 'CUSTOM_DAYS', scheduleData: { daysOfWeek: [1, 2, 3] } })
    expect(r).toEqual({ ok: true, data: undefined })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
