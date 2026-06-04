import { describe, it, expect, vi } from 'vitest'
import { detectPortionAnomaly } from './anomaly-detector'
import type { PrismaClient } from '@prisma/client'

/**
 * MEGA-4a (П10): динамический детектор «цифра вне нормы».
 * Порог 50–200% от среднего клиента по дню недели за 90 дней.
 * Глобальный MIN=10 убран — 8 порций при истории ~9 больше НЕ аномалия.
 *
 * deliveryDate в БД — @db.Date (UTC-полночь). UTC-полночь сохраняет день
 * недели и в МСК (+3ч не пересекает границу суток). 2026-06-04 = четверг.
 */

const THURSDAY = new Date('2026-06-04T00:00:00.000Z')

/** Прошлый четверг N недель назад (UTC-полночь). */
function pastThursday(weeksAgo: number): Date {
  return new Date(THURSDAY.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000)
}

/** Прошлая пятница N недель назад — для проверки фильтра по дню недели. */
function pastFriday(weeksAgo: number): Date {
  return new Date(THURSDAY.getTime() + 24 * 60 * 60 * 1000 - weeksAgo * 7 * 24 * 60 * 60 * 1000)
}

function makePrisma(orders: Array<{ portions: number; deliveryDate: Date }>): PrismaClient {
  const findMany = vi.fn().mockResolvedValue(orders)
  return { order: { findMany } } as unknown as PrismaClient
}

const ctxBase = {
  clientId: 'client_1',
  locationId: 'loc_1',
  deliveryDate: THURSDAY,
}

describe('detectPortionAnomaly — cold-start (samples < 3)', () => {
  it('0 заказов → no_history, НЕ аномалия даже при proposed=1000', async () => {
    const prisma = makePrisma([])
    const res = await detectPortionAnomaly({ ...ctxBase, proposedPortions: 1000 }, prisma)
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBe('no_history')
    expect(res.expected).toBeUndefined()
  })

  it('2 заказа → no_history, НЕ аномалия', async () => {
    const prisma = makePrisma([
      { portions: 10, deliveryDate: pastThursday(1) },
      { portions: 10, deliveryDate: pastThursday(2) },
    ])
    const res = await detectPortionAnomaly({ ...ctxBase, proposedPortions: 1000 }, prisma)
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBe('no_history')
  })
})

describe('detectPortionAnomaly — границы при average=10', () => {
  const tenAvgOrders = [
    { portions: 10, deliveryDate: pastThursday(1) },
    { portions: 10, deliveryDate: pastThursday(2) },
    { portions: 10, deliveryDate: pastThursday(3) },
  ]

  it('proposed=8 (≥ 5) → НЕ аномалия', async () => {
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 8 },
      makePrisma(tenAvgOrders),
    )
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBeNull()
    expect(res.expected).toEqual({ min: 5, max: 20, average: 10, samples: 3 })
  })

  it('proposed=4 (< 5) → below_threshold', async () => {
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 4 },
      makePrisma(tenAvgOrders),
    )
    expect(res.isAnomaly).toBe(true)
    expect(res.reason).toBe('below_threshold')
    expect(res.expected?.average).toBe(10)
  })

  it('proposed=25 (> 20) → above_threshold', async () => {
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 25 },
      makePrisma(tenAvgOrders),
    )
    expect(res.isAnomaly).toBe(true)
    expect(res.reason).toBe('above_threshold')
  })

  it('proposed=20 (ровно 2×, строгое >) → НЕ аномалия', async () => {
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 20 },
      makePrisma(tenAvgOrders),
    )
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBeNull()
  })

  it('proposed=5 (ровно 0.5×, строгое <) → НЕ аномалия', async () => {
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 5 },
      makePrisma(tenAvgOrders),
    )
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBeNull()
  })
})

describe('detectPortionAnomaly — кейс «СК Техник»', () => {
  it('samples=20, average≈9, proposed=8 → НЕ аномалия (фикс ложного алёрта)', async () => {
    // 20 заказов вокруг 9 (среднее ≈9): 8 и 10 чередуются.
    const orders = Array.from({ length: 20 }, (_, i) => ({
      portions: i % 2 === 0 ? 8 : 10,
      deliveryDate: pastThursday(i + 1),
    }))
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 8 },
      makePrisma(orders),
    )
    expect(res.isAnomaly).toBe(false)
    expect(res.reason).toBeNull()
    expect(res.expected?.samples).toBe(20)
    expect(res.expected?.average).toBe(9)
  })
})

describe('detectPortionAnomaly — фильтр по дню недели (МСК)', () => {
  it('заказы на другие дни недели не попадают в выборку', async () => {
    // findMany вернёт смесь четвергов и пятниц; детектор фильтрует по dow.
    // Только 2 четверга → samples=2 → no_history (хотя всего 5 заказов).
    const orders = [
      { portions: 9, deliveryDate: pastThursday(1) },
      { portions: 9, deliveryDate: pastThursday(2) },
      { portions: 100, deliveryDate: pastFriday(1) },
      { portions: 100, deliveryDate: pastFriday(2) },
      { portions: 100, deliveryDate: pastFriday(3) },
    ]
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 9 },
      makePrisma(orders),
    )
    expect(res.reason).toBe('no_history')
    expect(res.isAnomaly).toBe(false)
  })

  it('три четверга проходят фильтр → выборка формируется, аномалия детектится', async () => {
    const orders = [
      { portions: 9, deliveryDate: pastThursday(1) },
      { portions: 9, deliveryDate: pastThursday(2) },
      { portions: 9, deliveryDate: pastThursday(3) },
      { portions: 100, deliveryDate: pastFriday(1) }, // пятница — отфильтруется
    ]
    const res = await detectPortionAnomaly(
      { ...ctxBase, proposedPortions: 100 },
      makePrisma(orders),
    )
    expect(res.expected?.samples).toBe(3)
    expect(res.isAnomaly).toBe(true)
    expect(res.reason).toBe('above_threshold')
  })
})

describe('detectPortionAnomaly — фильтр locationId', () => {
  it('locationId=null → findMany без фильтра по локации', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { order: { findMany } } as unknown as PrismaClient
    await detectPortionAnomaly(
      { clientId: 'c1', locationId: null, deliveryDate: THURSDAY, proposedPortions: 5 },
      prisma,
    )
    const where = findMany.mock.calls[0][0].where
    expect(where.locationId).toBeUndefined()
    expect(where.clientId).toBe('c1')
  })

  it('locationId задан → findMany фильтрует по локации', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { order: { findMany } } as unknown as PrismaClient
    await detectPortionAnomaly(
      { clientId: 'c1', locationId: 'loc_42', deliveryDate: THURSDAY, proposedPortions: 5 },
      prisma,
    )
    const where = findMany.mock.calls[0][0].where
    expect(where.locationId).toBe('loc_42')
  })
})
