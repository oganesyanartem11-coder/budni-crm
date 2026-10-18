import { beforeEach, describe, expect, it, vi } from 'vitest'

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
