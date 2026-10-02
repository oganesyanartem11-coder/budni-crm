import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Смена типа питания DYNAMIC → STICKY в карточке клиента: будущие
 * PENDING/DRAFT-заказы (0 порций, их больше никто не подтвердит вопросом)
 * chunked-механизмом B-5 становятся CONFIRMED с fixedPortions.
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    clientMealConfig: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    botConversation: { updateMany: vi.fn() },
    order: { count: vi.fn(), findMany: vi.fn(), update: vi.fn((args: unknown) => args) },
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
  orderType: 'STICKY' as const,
  deliveryHorizon: 'NEXT_DAY' as const,
  scheduleType: 'WEEKDAYS' as const,
  scheduleData: null,
  fixedPortions: 33,
  pricePerPortion: 300,
  validFrom: null,
  validTo: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue({ id: 'manager_1', role: 'MANAGER' })
  mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
    orderType: 'DYNAMIC',
    fixedPortions: null,
    clientId: 'client_h',
    scheduleType: 'WEEKDAYS',
    scheduleData: null,
    validFrom: null,
    validTo: null,
  })
  mockPrisma.clientMealConfig.update.mockResolvedValue({ clientId: 'client_h' })
  mockPrisma.order.count.mockResolvedValue(4)
  mockPrisma.clientMealConfig.count.mockResolvedValue(0)
  mockPrisma.botConversation.updateMany.mockResolvedValue({ count: 1 })
})

describe('updateMealConfig: DYNAMIC → STICKY', () => {
  it('без диалога: только PENDING/DRAFT → CONFIRMED с fixedPortions, CONFIRMED не трогаем', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      { id: 'o1', pricePerPortion: new Prisma.Decimal(300) },
    ])

    const r = await updateMealConfig('cfg_1', FORM)

    expect(r).toEqual({ ok: true, data: undefined })
    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    // уже подтверждённое клиентом число при смене типа не перезаписывается
    expect(where.status).toEqual({ in: ['DRAFT', 'PENDING_CONFIRMATION'] })
    expect(where.updDocumentLink).toEqual({ is: null })
    expect(where.sourceConfigId).toBe('cfg_1')
    const upd = mockPrisma.order.update.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> }
    expect(upd.where.id).toBe('o1')
    expect(upd.data).toMatchObject({ portions: 33, status: 'CONFIRMED' })
    expect(Number(upd.data.totalPrice)).toBe(9900)
    expect(mockPrisma.clientMealConfig.update).toHaveBeenCalledWith({
      where: { id: 'cfg_1' },
      data: expect.objectContaining({ orderType: 'STICKY', fixedPortions: 33 }),
    })
    expect(mockPrisma.order.count).not.toHaveBeenCalled() // диалога B-5 нет
  })

  it('DYNAMIC у клиента больше нет → сегодняшний вопрос бота закрыт', async () => {
    mockPrisma.order.findMany.mockResolvedValue([])
    await updateMealConfig('cfg_1', FORM)
    expect(mockPrisma.botConversation.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client_h', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    })
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'MEAL_CONFIG_TYPE_SWITCHED',
        payload: expect.objectContaining({ oldOrderType: 'DYNAMIC', newOrderType: 'STICKY' }),
      }),
    })
  })

  it('STICKY без количества порций — ошибка валидации', async () => {
    const r = await updateMealConfig('cfg_1', { ...FORM, fixedPortions: null })
    expect(r).toEqual({ ok: false, error: 'Укажите количество порций' })
  })
})
