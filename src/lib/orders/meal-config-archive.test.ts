/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * Архивация клиента / отключение питания отменяют ТОЛЬКО будущие заказы —
 * с завтрашнего МСК-дня. Раньше граница была моментом МСК-полуночи (21:00Z
 * вчера), который @db.Date обрезал до вчерашней даты → отменялись вчера и
 * сегодня. Плюс журнал MEAL_CONFIG_CREATED / MEAL_CONFIG_DELETED (18.10).
 */

const { mockPrisma, mockRequireRole } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findUnique: vi.fn(), update: vi.fn((a: any) => a) },
    clientMealConfig: {
      findUnique: vi.fn(),
      update: vi.fn((a: any) => a),
      updateMany: vi.fn((a: any) => a),
      count: vi.fn(),
      create: vi.fn(),
    },
    order: { findMany: vi.fn(), updateMany: vi.fn((a: any) => a) },
    activityLog: { create: vi.fn((a: any) => a) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/telegram/notify', () => ({ notifyProductionChannel: vi.fn(), escapeHtml: (s: string) => s }))
vi.mock('@/lib/orders/generate-orders', () => ({ generateFixedOrdersForRange: vi.fn(async () => ({ created: 0 })) }))

import { archiveClient, createMealConfigBulk, deleteMealConfig } from '@/app/(app)/clients/actions'

const TOMORROW = new Date('2026-10-19T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T09:00:00.000Z')) // 12:00 МСК
  mockRequireRole.mockResolvedValue({ id: 'admin_1', role: 'ADMIN' })
  mockPrisma.order.findMany.mockResolvedValue([])
  mockPrisma.clientMealConfig.count.mockResolvedValue(2)
})

describe('archiveClient: граница отмены', () => {
  it('отменяет заказы с завтрашнего дня (findMany и updateMany), сегодняшний не трогает', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: 'СБМ', isActive: true })

    const r = await archiveClient('c1')

    expect(r.ok).toBe(true)
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({ gte: TOMORROW })
    expect(mockPrisma.order.updateMany.mock.calls[0][0].where).toMatchObject({
      clientId: 'c1',
      deliveryDate: { gte: TOMORROW },
      status: { in: expect.arrayContaining(['LOCKED']) },
    })
  })
})

describe('deleteMealConfig', () => {
  it('деактивация: отменяет с завтрашнего дня + MEAL_CONFIG_DELETED', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
      id: 'cfg_1', clientId: 'c1', locationId: 'loc_1', mealType: 'LUNCH', orderType: 'DYNAMIC', isActive: true,
    })
    mockPrisma.order.findMany.mockResolvedValue([{ deliveryDate: TOMORROW, mealType: 'LUNCH', portions: 8, status: 'CONFIRMED' }])

    const r = await deleteMealConfig('cfg_1')

    expect(r).toEqual({ ok: true, data: { cancelledCount: 1 } })
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({ gte: TOMORROW })
    expect(mockPrisma.order.updateMany.mock.calls[0][0].where.deliveryDate).toEqual({ gte: TOMORROW })
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin_1',
        userRole: 'ADMIN',
        action: 'MEAL_CONFIG_DELETED',
        entityType: 'ClientMealConfig',
        entityId: 'cfg_1',
        payload: { clientId: 'c1', locationId: 'loc_1', mealType: 'LUNCH', orderType: 'DYNAMIC', cancelledCount: 1 },
      },
    })
  })
})

describe('createMealConfigBulk: журнал', () => {
  it('по записи MEAL_CONFIG_CREATED на каждый конфиг, с пользователем', async () => {
    mockPrisma.clientMealConfig.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: `cfg_${data.mealType}`,
      ...data,
      pricePerPortion: new Prisma.Decimal(data.pricePerPortion as number),
    }))

    const r = await createMealConfigBulk('c1', {
      locationId: 'loc_1',
      mealTypes: ['LUNCH', 'DINNER'],
      pricesByType: { LUNCH: 300, DINNER: 350 },
      orderType: 'DYNAMIC',
      deliveryHorizon: 'NEXT_DAY',
      scheduleType: 'DAILY',
      scheduleData: null,
      fixedPortionsByType: null,
      validFrom: null,
      validTo: null,
    })

    expect(r.ok).toBe(true)
    const logs = mockPrisma.activityLog.create.mock.calls.map((c) => c[0].data)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toMatchObject({
      userId: 'admin_1',
      action: 'MEAL_CONFIG_CREATED',
      entityType: 'ClientMealConfig',
      entityId: 'cfg_DINNER',
      payload: { clientId: 'c1', mealType: 'DINNER', orderType: 'DYNAMIC', pricePerPortion: 350, scheduleData: null },
    })
  })
})
