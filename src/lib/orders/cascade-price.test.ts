import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

/**
 * П6: каскад изменения ЦЕНЫ ClientMealConfig на будущие заказы.
 *
 * Тестируем server actions cascadePriceToFutureOrders / previewPriceCascade
 * напрямую. requireRole в проде делает redirect() — здесь мокаем его
 * resolved-значением (как в contact-actions.test.ts).
 *
 * Фильтрация заказов (статус/дата/бизнес-ключ) выполняется в БД через
 * where-clause, поэтому в unit-тесте мы:
 *  - проверяем САМ where-clause (бизнес-ключ + статусы CONFIRMED/PENDING +
 *    deliveryDate >= завтра по МСК) — гарантия, что DRAFT/LOCKED/сегодня/
 *    чужой ключ не попадут в выборку;
 *  - подаём в findMany «как будто отфильтрованные» заказы и проверяем, что
 *    каждому проставляется pricePerPortion=newPrice и totalPrice=newPrice*portions.
 *
 * Кейсы статусов/дат описаны как ассерты на содержимое where (вместо реального
 * БД-прогона), а кейсы BOT(sourceConfigId=null)/MANUAL — тем, что в where НЕТ
 * фильтра по sourceConfigId/source, значит такие заказы матчатся наравне.
 */

const { mockPrisma, mockRequireRole, mockGetMskCalendarDayUtc } = vi.hoisted(() => ({
  mockPrisma: {
    clientMealConfig: { findUnique: vi.fn() },
    order: { findMany: vi.fn(), update: vi.fn() },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockRequireRole: vi.fn(),
  mockGetMskCalendarDayUtc: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/utils/msk-window', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/msk-window')>()
  return { ...actual, getMskCalendarDayUtc: mockGetMskCalendarDayUtc }
})

import { cascadePriceToFutureOrders, previewPriceCascade } from '@/app/(app)/clients/actions'

const ADMIN = { id: 'u_admin', role: 'ADMIN' as const }
const TOMORROW = new Date('2026-06-06T00:00:00.000Z')

const CONFIG = {
  clientId: 'cl1',
  locationId: 'loc1',
  mealType: 'LUNCH' as const,
  pricePerPortion: new Prisma.Decimal('300.00'),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(ADMIN)
  mockGetMskCalendarDayUtc.mockReturnValue(TOMORROW)
  mockPrisma.activityLog.create.mockResolvedValue({})
  // $transaction(array) — выполняем переданные «промисы» как есть.
  mockPrisma.$transaction.mockImplementation(async (arr: unknown[]) => arr)
  mockPrisma.order.update.mockImplementation((args: unknown) => args)
})

describe('cascadePriceToFutureOrders — where-clause (бизнес-ключ, статусы, дата)', () => {
  it('матчит по бизнес-ключу (clientId, locationId, mealType), НЕ по sourceConfigId', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([])

    await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.clientId).toBe('cl1')
    expect(where.locationId).toBe('loc1')
    expect(where.mealType).toBe('LUNCH')
    // КРИТИЧНО: НЕТ фильтра по sourceConfigId/source → BOT(null) и MANUAL матчатся.
    expect(where.sourceConfigId).toBeUndefined()
    expect(where.source).toBeUndefined()
  })

  it('статусы = только CONFIRMED + PENDING_CONFIRMATION (DRAFT/LOCKED не попадут)', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([])

    await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.status.in).toEqual(['CONFIRMED', 'PENDING_CONFIRMATION'])
    expect(where.status.in).not.toContain('DRAFT')
    expect(where.status.in).not.toContain('LOCKED')
  })

  it('deliveryDate >= завтра по МСК (сегодня и раньше исключены)', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([])

    await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })

    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.deliveryDate).toEqual({ gte: TOMORROW })
    // offset = 1 (завтра), а не 0 (сегодня).
    expect(mockGetMskCalendarDayUtc).toHaveBeenCalledWith(expect.any(Date), 1)
  })

})

describe('cascadePriceToFutureOrders — обновление заказов', () => {
  it('каждому заказу: pricePerPortion=newPrice, totalPrice=newPrice*portions', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    // «Отфильтрованные» БД заказы: CONFIRMED+завтра, PENDING+след.неделя,
    // BOT(sourceConfigId косвенно null — здесь не важно), MANUAL с другой ценой.
    mockPrisma.order.findMany.mockResolvedValue([
      { id: 'o_confirmed_tomorrow', portions: 10 },
      { id: 'o_pending_nextweek', portions: 4 },
      { id: 'o_bot_null_src', portions: 7 },
      { id: 'o_manual_diffprice', portions: 1 },
    ])

    const res = await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.affectedCount).toBe(4)
      expect(res.oldPrice).toBe(300)
      expect(res.newPrice).toBe(350)
    }

    // Один $transaction (4 < 100).
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce()
    const updates = mockPrisma.order.update.mock.calls.map((c) => c[0])
    expect(updates).toHaveLength(4)

    const byId = Object.fromEntries(updates.map((u) => [u.where.id, u.data]))
    expect(byId['o_confirmed_tomorrow'].pricePerPortion.toString()).toBe('350')
    expect(byId['o_confirmed_tomorrow'].totalPrice.toString()).toBe('3500')
    expect(byId['o_pending_nextweek'].totalPrice.toString()).toBe('1400')
    expect(byId['o_bot_null_src'].totalPrice.toString()).toBe('2450')
    expect(byId['o_manual_diffprice'].totalPrice.toString()).toBe('350')
  })

  it('пустая выборка → 0 заказов, $transaction не вызывается, но лог пишется', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([])

    const res = await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.affectedCount).toBe(0)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.activityLog.create).toHaveBeenCalledOnce()
  })

  it('партии по 100: 150 заказов → 2 транзакции', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `o${i}`, portions: 2 }))
    mockPrisma.order.findMany.mockResolvedValue(many)

    const res = await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.affectedCount).toBe(150)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('Decimal-вход для newPrice работает (300.50 * 3 = 901.5)', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([{ id: 'o1', portions: 3 }])

    await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: new Prisma.Decimal('300.50') })

    const data = mockPrisma.order.update.mock.calls[0][0].data
    expect(data.pricePerPortion.toString()).toBe('300.5')
    expect(data.totalPrice.toString()).toBe('901.5')
  })
})

describe('cascadePriceToFutureOrders — guards', () => {
  it('конфиг не найден → ok:false, заказы не трогаем', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(null)
    const res = await cascadePriceToFutureOrders({ configId: 'missing', newPrice: 350 })
    expect(res.ok).toBe(false)
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled()
  })

  it('отрицательная цена → ok:false', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    const res = await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: -5 })
    expect(res.ok).toBe(false)
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled()
  })

  it('требует роль ADMIN/MANAGER', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(CONFIG)
    mockPrisma.order.findMany.mockResolvedValue([])
    await cascadePriceToFutureOrders({ configId: 'cfg1', newPrice: 350 })
    expect(mockRequireRole).toHaveBeenCalledWith(['ADMIN', 'MANAGER'])
  })
})

describe('previewPriceCascade', () => {
  it('считает count + oldTotal (текущие totalPrice) + newTotal (newPrice*portions)', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
      clientId: 'cl1',
      locationId: 'loc1',
      mealType: 'LUNCH',
    })
    mockPrisma.order.findMany.mockResolvedValue([
      { portions: 10, totalPrice: new Prisma.Decimal('3000') },
      { portions: 5, totalPrice: new Prisma.Decimal('1500') },
    ])

    const res = await previewPriceCascade({ configId: 'cfg1', newPrice: 350 })
    expect(res.count).toBe(2)
    expect(res.oldTotal).toBe(4500) // 3000 + 1500
    expect(res.newTotal).toBe(5250) // 350*10 + 350*5
  })

  it('использует тот же where-clause (бизнес-ключ + статусы + дата)', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue({
      clientId: 'cl1',
      locationId: 'loc1',
      mealType: 'LUNCH',
    })
    mockPrisma.order.findMany.mockResolvedValue([])

    await previewPriceCascade({ configId: 'cfg1', newPrice: 350 })
    const where = mockPrisma.order.findMany.mock.calls[0][0].where
    expect(where.status.in).toEqual(['CONFIRMED', 'PENDING_CONFIRMATION'])
    expect(where.deliveryDate).toEqual({ gte: TOMORROW })
    expect(where.clientId).toBe('cl1')
  })

  it('конфиг не найден → нули', async () => {
    mockPrisma.clientMealConfig.findUnique.mockResolvedValue(null)
    const res = await previewPriceCascade({ configId: 'missing', newPrice: 350 })
    expect(res).toEqual({ count: 0, oldTotal: 0, newTotal: 0 })
  })
})
