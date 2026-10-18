import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Аудит дат 18.10 (@db.Date deliveryDate = UTC-полночь МСК-дня):
 *  - listOrdersForWeek получал МСК-инстант понедельника (Вс 21:00Z) → Prisma
 *    усекал до ВОСКРЕСЕНЬЯ: прошлое Вс внутри, текущее Вс — нет;
 *  - pending today/tomorrow через date-fns startOfDay (UTC) → в 00:00–03:00 МСК
 *    «вчера+сегодня».
 */
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { order: { findMany: vi.fn(), count: vi.fn() } },
}))
vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  listOrdersForWeek,
  countPendingConfirmationToday,
  listPendingConfirmation,
  listPendingCutoffData,
} from './orders'
import { getMondayOfWeek } from '@/lib/utils/week'

beforeEach(() => {
  mockPrisma.order.findMany.mockReset().mockResolvedValue([])
  mockPrisma.order.count.mockReset().mockResolvedValue(0)
})
afterEach(() => vi.useRealTimers())

describe('listOrdersForWeek — Пн 00:00Z … след. Пн 00:00Z', () => {
  it('Пн 19.10 01:30 МСК (getMondayOfWeek → 18.10 21:00Z) → [19.10, 26.10)', async () => {
    const monday = getMondayOfWeek(new Date('2026-10-18T22:30:00.000Z'))
    expect(monday.toISOString()).toBe('2026-10-18T21:00:00.000Z') // МСК-инстант
    await listOrdersForWeek(monday)
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-19T00:00:00.000Z'),
      lt: new Date('2026-10-26T00:00:00.000Z'),
    })
  })

  it('Вс 18.10 12:00 МСК → неделя 12.10 … 18.10 включая воскресенье', async () => {
    await listOrdersForWeek(getMondayOfWeek(new Date('2026-10-18T09:00:00.000Z')))
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-12T00:00:00.000Z'),
      lt: new Date('2026-10-19T00:00:00.000Z'),
    })
  })

  it('UTC-полночь понедельника на входе — тот же результат', async () => {
    await listOrdersForWeek(new Date('2026-10-19T00:00:00.000Z'))
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual({
      gte: new Date('2026-10-19T00:00:00.000Z'),
      lt: new Date('2026-10-26T00:00:00.000Z'),
    })
  })
})

describe('pending confirmation — МСК-сегодня и МСК-завтра', () => {
  const expected = {
    gte: new Date('2026-10-19T00:00:00.000Z'),
    lte: new Date('2026-10-20T00:00:00.000Z'),
  }

  it.each([
    ['ночь 19.10 01:30 МСК', '2026-10-18T22:30:00.000Z'],
    ['день 19.10 12:00 МСК', '2026-10-19T09:00:00.000Z'],
  ])('%s → deliveryDate 19.10..20.10', async (_n, nowIso) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    await countPendingConfirmationToday()
    await listPendingConfirmation()
    await listPendingCutoffData()
    expect(mockPrisma.order.count.mock.calls[0][0].where.deliveryDate).toEqual(expected)
    expect(mockPrisma.order.findMany.mock.calls[0][0].where.deliveryDate).toEqual(expected)
    expect(mockPrisma.order.findMany.mock.calls[1][0].where.deliveryDate).toEqual(expected)
  })
})
