import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireRole,
  mockOrderFindMany,
  mockOrderCount,
  mockCompleteCore,
  mockManagerCompleteCore,
  mockLegacyComplete,
  mockTransaction,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockOrderFindMany: vi.fn(),
  mockOrderCount: vi.fn(),
  mockCompleteCore: vi.fn(),
  mockManagerCompleteCore: vi.fn(),
  mockLegacyComplete: vi.fn(),
  mockTransaction: vi.fn(),
  mockRevalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    order: { findMany: mockOrderFindMany, count: mockOrderCount },
  },
}))
vi.mock('@/lib/db/prisma-direct', () => ({
  prismaDirect: { $transaction: mockTransaction },
}))
vi.mock('@/lib/delivery/route-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/route-completion')>()
  return { ...actual, completeRouteStopCore: mockCompleteCore }
})
vi.mock('@/lib/delivery/delivery-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/delivery-override')>()
  return { ...actual, completeRouteStopAsManagerCore: mockManagerCompleteCore }
})
vi.mock('@/lib/delivery/legacy-stop-mutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/legacy-stop-mutations')>()
  return { ...actual, markLegacyStopDeliveredInTransaction: mockLegacyComplete }
})
vi.mock('@/lib/delivery/prisma-transaction-retry', () => ({
  runWithPrismaConflictRetry: (callback: () => unknown) => callback(),
}))
vi.mock('@/lib/boris/team-channels', () => ({
  logBorisEvent: vi.fn(),
  emitLivePost: vi.fn(),
}))
vi.mock('@/lib/telegram/notify', () => ({
  notifyAllManagersDirect: vi.fn(),
  escapeHtml: (value: string) => value,
}))
vi.mock('@/lib/telegram/buttons', () => ({ orderDetailButton: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))

import { markStopDelivered } from './actions'

const courier = { id: 'courier-1', name: 'Анна', role: 'COURIER' as const }

function linkedOrder() {
  return {
    id: 'order-1',
    routeStopId: 'stop-1',
    routeStop: { id: 'stop-1', version: 3, assignmentMode: 'IN_HOUSE' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue(courier)
  mockTransaction.mockImplementation(async (callback) => callback({ tx: true }))
  mockOrderCount.mockResolvedValue(0)
})

describe('markStopDelivered Delivery 2.0 bridge', () => {
  it('cannot bypass a linked stop geofence through the legacy orderIds action', async () => {
    mockOrderFindMany.mockResolvedValue([linkedOrder()])
    mockCompleteCore.mockResolvedValue({
      stopId: 'stop-1',
      delivered: false,
      idempotent: false,
      version: 3,
      completionMethod: null,
      geoAttempt: {
        id: 'attempt-1',
        result: 'POSITION_UNAVAILABLE',
        distanceM: null,
      },
    })

    const result = await markStopDelivered({
      orderIds: ['order-1'],
      expectedUpdatedAts: { 'order-1': '2026-08-12T07:00:00.000Z' },
    })

    expect(mockCompleteCore).toHaveBeenCalledWith(courier, expect.objectContaining({
      stopId: 'stop-1',
      expectedVersion: 3,
      position: null,
    }))
    expect(mockLegacyComplete).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('геопозици'),
    })
  })

  it('keeps the hardened legacy transaction only for orders not materialized yet', async () => {
    mockOrderFindMany.mockResolvedValue([{ id: 'order-legacy', routeStopId: null, routeStop: null }])
    mockLegacyComplete.mockResolvedValue({
      updated: 1,
      orderIds: ['order-legacy'],
      orders: [],
    })

    const result = await markStopDelivered({
      orderIds: ['order-legacy'],
      expectedUpdatedAts: { 'order-legacy': '2026-08-12T07:00:00.000Z' },
    })

    expect(mockLegacyComplete).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({ actor: courier, orderIds: ['order-legacy'] }),
    )
    expect(mockCompleteCore).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, data: { updated: 1 } })
  })
})
