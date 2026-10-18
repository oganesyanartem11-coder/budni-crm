/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Аудит дат 18.10:
 *  - архивация точки отменяет её заказы с ЗАВТРА (раньше не отменяла ничего —
 *    кухня готовила, счёт выставлялся, в маршрутный лист не попадало);
 *  - пересчёт цены не трогает заказы с выписанным УПД;
 *  - «Досоздать на завтра» ночью по МСК создаёт заказы на завтра, а не на сегодня.
 */

const { mockPrisma, mockRequireRole, mockGenerate } = vi.hoisted(() => ({
  mockPrisma: {
    client: { findUnique: vi.fn() },
    clientLocation: { findUnique: vi.fn(), update: vi.fn((a: any) => a) },
    clientMealConfig: { findUnique: vi.fn() },
    order: { findMany: vi.fn(), updateMany: vi.fn((a: any) => a) },
    activityLog: { create: vi.fn((a: any) => a) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  mockRequireRole: vi.fn(),
  mockGenerate: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/telegram/notify', () => ({ notifyProductionChannel: vi.fn(async () => {}), escapeHtml: (s: string) => s }))
vi.mock('@/lib/orders/generate-orders', () => ({
  generateFixedOrdersForDate: mockGenerate,
  generateFixedOrdersForRange: vi.fn(async () => ({ created: 0 })),
}))

import { archiveLocation, previewPriceCascade } from '@/app/(app)/clients/actions'
import { regenerateFixedOrders } from '@/app/(app)/orders/actions'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockRequireRole.mockResolvedValue({ id: 'admin_1', role: 'ADMIN' })
})
afterEach(() => vi.useRealTimers())

describe('archiveLocation', () => {
  it('архивация: отменяем заказы точки только с завтра и без УПД, пишем в журнал', async () => {
    vi.setSystemTime(new Date('2026-10-18T09:00:00.000Z')) // вс 12:00 МСК
    mockPrisma.clientLocation.findUnique.mockResolvedValue({ id: 'loc_1', clientId: 'c1', name: 'Склад', isActive: true })
    mockPrisma.order.findMany.mockResolvedValue([
      { deliveryDate: new Date('2026-10-19T00:00:00.000Z'), mealType: 'LUNCH', portions: 20, status: 'CONFIRMED' },
    ])

    const r = await archiveLocation('loc_1')

    const where = mockPrisma.order.updateMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      locationId: 'loc_1',
      deliveryDate: { gte: new Date('2026-10-19T00:00:00.000Z') },
      updDocumentLink: { is: null },
    })
    expect(mockPrisma.order.updateMany.mock.calls[0][0].data).toEqual({ status: 'CANCELLED' })
    expect(mockPrisma.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'LOCATION_ARCHIVED',
      payload: { clientId: 'c1', name: 'Склад', cancelledCount: 1 },
    })
    expect(r).toEqual({ ok: true, data: { cancelledCount: 1 } })
  })

  it('восстановление — только тоггл, заказы не трогаем', async () => {
    mockPrisma.clientLocation.findUnique.mockResolvedValue({ id: 'loc_1', clientId: 'c1', name: 'Склад', isActive: false })
    const r = await archiveLocation('loc_1')
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, data: { cancelledCount: 0 } })
  })
})

describe('previewPriceCascade', () => {
  it('заказы с выписанным УПД в пересчёт цены не попадают', async () => {
    vi.setSystemTime(new Date('2026-10-18T09:00:00.000Z'))
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
      id: 'cfg', clientId: 'c1', locationId: 'loc_1', mealType: 'LUNCH', pricePerPortion: 300,
    })
    mockPrisma.order.findMany.mockResolvedValue([])
    await previewPriceCascade({ configId: 'cfg', newPrice: 350 })
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.updDocumentLink).toEqual({ is: null })
  })
})

describe('regenerateFixedOrders («Досоздать на завтра»)', () => {
  beforeEach(() => {
    mockGenerate.mockResolvedValue({ created: 0, skippedExisting: 0, matchedSchedule: 0, candidatesTotal: 0 })
  })

  it('кнопка шлёт YYYY-MM-DD завтрашнего МСК-дня → генерация на эту дату', async () => {
    await regenerateFixedOrders('2026-10-19')
    expect(mockGenerate.mock.calls[0][0]).toEqual(new Date('2026-10-19T00:00:00.000Z'))
  })

  it('старый формат: «полночь завтра по МСК» (сегодня 21:00Z) → завтра, а не сегодня', async () => {
    await regenerateFixedOrders('2026-10-18T21:00:00.000Z')
    expect(mockGenerate.mock.calls[0][0]).toEqual(new Date('2026-10-19T00:00:00.000Z'))
  })
})
