import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindMany, mockUpdateMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    deliveryGeoAttempt: {
      findMany: mockFindMany,
      updateMany: mockUpdateMany,
    },
  },
}))
vi.mock('@/lib/cron/with-heartbeat', () => ({
  withCronHeartbeat: (_name: string, cronHandler: unknown) => cronHandler,
}))

import {
  DELIVERY_GEO_PURGE_BATCH_SIZE,
  DELIVERY_GEO_RAW_RETENTION_DAYS,
  handler,
} from './route'

const NOW = new Date('2026-08-21T12:00:00.000Z')
const REQUEST = new Request('http://local/api/cron/cleanup-delivery-geo')

beforeEach(() => {
  vi.clearAllMocks()
  mockFindMany.mockResolvedValue([])
  mockUpdateMany.mockResolvedValue({ count: 0 })
})

describe('cleanup-delivery-geo cron', () => {
  it('purges only raw courier coordinates older than 60 days in a bounded batch', async () => {
    mockFindMany.mockResolvedValue([{ id: 'geo-old-1' }, { id: 'geo-old-2' }])
    mockUpdateMany.mockResolvedValue({ count: 2 })

    const response = await handler(REQUEST, NOW)
    expect(await response.json()).toEqual({
      ok: true,
      purged: 2,
      retentionDays: 60,
      batchSize: DELIVERY_GEO_PURGE_BATCH_SIZE,
      hasMore: false,
    })
    expect(DELIVERY_GEO_RAW_RETENTION_DAYS).toBe(60)
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        receivedAt: { lt: new Date('2026-06-22T12:00:00.000Z') },
        purgedAt: null,
        OR: [
          { courierLatitude: { not: null } },
          { courierLongitude: { not: null } },
        ],
      },
      select: { id: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: DELIVERY_GEO_PURGE_BATCH_SIZE,
    })
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['geo-old-1', 'geo-old-2'] } }),
      data: {
        courierLatitude: null,
        courierLongitude: null,
        purgedAt: NOW,
      },
    }))
  })

  it('keeps recent/already-purged rows and is idempotent when no eligible ids remain', async () => {
    const first = await handler(REQUEST, NOW)
    const second = await handler(REQUEST, NOW)

    expect(await first.json()).toMatchObject({ ok: true, purged: 0, hasMore: false })
    expect(await second.json()).toMatchObject({ ok: true, purged: 0, hasMore: false })
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('uses a free daily UTC minute and stays within the current Vercel cron capacity', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    const cleanup = vercel.crons.filter((entry) => entry.path === '/api/cron/cleanup-delivery-geo')

    expect(cleanup).toEqual([{
      path: '/api/cron/cleanup-delivery-geo',
      schedule: '15 0 * * *',
    }])
    expect(vercel.crons.filter((entry) => entry.schedule === '15 0 * * *')).toHaveLength(1)
    expect(vercel.crons.length).toBeLessThanOrEqual(100)
  })
})
