import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireRole,
  mockEnsure,
  mockStartCore,
  mockAssignCore,
  mockTransaction,
  mockRevalidatePath,
  mockCompleteStopCore,
  mockCreateOverrideCore,
  mockResolveOverrideCore,
  mockManagerCompleteCore,
  mockNotifyManagers,
  mockOverrideFindUnique,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockEnsure: vi.fn(),
  mockStartCore: vi.fn(),
  mockAssignCore: vi.fn(),
  mockTransaction: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockCompleteStopCore: vi.fn(),
  mockCreateOverrideCore: vi.fn(),
  mockResolveOverrideCore: vi.fn(),
  mockManagerCompleteCore: vi.fn(),
  mockNotifyManagers: vi.fn(),
  mockOverrideFindUnique: vi.fn(),
}))

vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/delivery/route-materializer', () => ({
  ensureCourierRouteStopsForDate: mockEnsure,
}))
vi.mock('@/lib/delivery/route-mutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/route-mutations')>()
  return {
    ...actual,
    startOwnCourierRouteInTransaction: mockStartCore,
    assignCourierRouteStopInTransaction: mockAssignCore,
  }
})
vi.mock('@/lib/delivery/route-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/route-completion')>()
  return { ...actual, completeRouteStopCore: mockCompleteStopCore }
})
vi.mock('@/lib/delivery/delivery-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/delivery-override')>()
  return {
    ...actual,
    createDeliveryOverrideRequestCore: mockCreateOverrideCore,
    resolveDeliveryOverrideRequestCore: mockResolveOverrideCore,
    completeRouteStopAsManagerCore: mockManagerCompleteCore,
  }
})
vi.mock('@/lib/db/prisma-direct', () => ({
  prismaDirect: { $transaction: mockTransaction },
}))
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    deliveryOverrideRequest: { findUnique: mockOverrideFindUnique },
  },
}))
vi.mock('@/lib/telegram/notify', () => ({
  escapeHtml: (value: string) => value,
  notifyAllManagersDirect: mockNotifyManagers,
}))
vi.mock('@/lib/telegram/buttons', () => ({
  deliveryOverrideButtons: vi.fn(() => ({ keyboard: true })),
}))
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

import {
  assignCourierRouteStop,
  completeOwnRouteStop,
  completeRouteStopAsManager,
  requestDeliveryOverride,
  resolveDeliveryOverrideAsManager,
  startOwnCourierRoute,
} from './route-actions'

const courier = { id: 'courier-1', name: 'Анна', role: 'COURIER' }
const manager = { id: 'manager-1', name: 'Мария', role: 'MANAGER' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockTransaction.mockImplementation(async (callback) => callback({ tx: true }))
  mockEnsure.mockResolvedValue({})
  mockNotifyManagers.mockResolvedValue({ sentTo: 1, skippedNoTelegram: 0, failed: 0 })
  mockOverrideFindUnique.mockResolvedValue({
    id: 'override-1',
    comment: 'Клиент у соседнего входа',
    courierNameSnapshot: 'Анна',
    expiresAt: new Date('2026-08-12T08:15:00.000Z'),
    geoAttempt: { result: 'OUTSIDE_GEOFENCE', distanceM: 1_240 },
    stop: {
      clientNameSnapshot: 'Клиент',
      locationNameSnapshot: 'Точка',
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startOwnCourierRoute', () => {
  it('uses authenticated courier and exact today @db.Date across the MSK boundary', async () => {
    const current = new Date('2026-08-05T21:30:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(courier)
    mockStartCore.mockResolvedValue({
      routeDayId: 'route-1',
      startedAt: current,
      updated: true,
    })

    const result = await startOwnCourierRoute()

    const deliveryDate = new Date('2026-08-06T00:00:00.000Z')
    expect(mockRequireRole).toHaveBeenCalledWith(['COURIER'])
    expect(mockEnsure).toHaveBeenCalledWith(deliveryDate, current)
    expect(mockStartCore).toHaveBeenCalledWith(
      { tx: true },
      { actor: courier, deliveryDate, now: current },
    )
    expect(mockTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        maxWait: 5_000,
        timeout: 10_000,
        isolationLevel: 'Serializable',
      },
    )
    expect(mockRevalidatePath).toHaveBeenCalledWith('/delivery')
    expect(result).toEqual({
      ok: true,
      data: { routeDayId: 'route-1', startedAt: current, updated: true },
    })
  })
})

describe('assignCourierRouteStop', () => {
  it('requires a manager role and passes only validated assignment data', async () => {
    const current = new Date('2026-08-12T06:00:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(manager)
    mockAssignCore.mockResolvedValue({ stopId: 'stop-1', version: 4, updated: true })

    const result = await assignCourierRouteStop({
      stopId: 'stop-1',
      expectedVersion: 3,
      assignmentMode: 'EXTERNAL',
      courierId: null,
    })

    expect(mockRequireRole).toHaveBeenCalledWith(['ADMIN', 'MANAGER'])
    expect(mockAssignCore).toHaveBeenCalledWith(
      { tx: true },
      {
        actor: manager,
        stopId: 'stop-1',
        expectedVersion: 3,
        assignmentMode: 'EXTERNAL',
        courierId: null,
        now: current,
      },
    )
    expect(mockRevalidatePath).toHaveBeenCalledWith('/delivery')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/production/print/assembly')
    expect(result).toEqual({
      ok: true,
      data: { stopId: 'stop-1', version: 4, updated: true },
    })
  })

  it('rejects invalid input before opening a transaction', async () => {
    mockRequireRole.mockResolvedValue(manager)

    const result = await assignCourierRouteStop({
      stopId: '',
      expectedVersion: 0,
      assignmentMode: 'IN_HOUSE',
      courierId: null,
    })

    expect(result.ok).toBe(false)
    expect(mockTransaction).not.toHaveBeenCalled()
  })
})

describe('completeOwnRouteStop', () => {
  it('passes an explicit authenticated actor and validated GPS without courierId', async () => {
    const current = new Date('2026-08-12T08:00:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(courier)
    mockCompleteStopCore.mockResolvedValue({
      stopId: 'stop-1',
      delivered: true,
      idempotent: false,
      version: 4,
      completionMethod: 'GEOFENCE',
      geoAttempt: { id: 'attempt-1', result: 'ALLOWED', distanceM: 320 },
    })

    const result = await completeOwnRouteStop({
      stopId: 'stop-1',
      expectedVersion: 3,
      requestId: 'gps-request-1',
      position: {
        latitude: 55.75,
        longitude: 37.61,
        accuracyM: 40,
        capturedAt: '2026-08-12T07:59:50.000Z',
      },
    })

    expect(mockRequireRole).toHaveBeenCalledWith(['COURIER'])
    expect(mockCompleteStopCore).toHaveBeenCalledWith(courier, {
      stopId: 'stop-1',
      expectedVersion: 3,
      requestId: 'gps-request-1',
      position: {
        latitude: 55.75,
        longitude: 37.61,
        accuracyM: 40,
        capturedAt: new Date('2026-08-12T07:59:50.000Z'),
      },
      now: current,
    })
    expect(mockRevalidatePath).toHaveBeenCalledWith('/delivery')
    expect(mockRevalidatePath).toHaveBeenCalledWith('/delivery/stops/stop-1')
    expect(result.ok).toBe(true)
  })

  it('rejects invalid GPS before the Core', async () => {
    mockRequireRole.mockResolvedValue(courier)

    const result = await completeOwnRouteStop({
      stopId: 'stop-1',
      expectedVersion: 3,
      requestId: 'gps-request-1',
      position: {
        latitude: 91,
        longitude: 37.61,
        accuracyM: 40,
        capturedAt: 'not-a-date',
      },
    })

    expect(result.ok).toBe(false)
    expect(mockCompleteStopCore).not.toHaveBeenCalled()
  })
})

describe('requestDeliveryOverride', () => {
  it('keeps the committed CRM request when Telegram delivery fails', async () => {
    const current = new Date('2026-08-12T08:00:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(courier)
    mockCreateOverrideCore.mockResolvedValue({
      requestId: 'override-1',
      stopId: 'stop-1',
      status: 'PENDING',
      expiresAt: new Date('2026-08-12T08:15:00.000Z'),
      created: true,
    })
    mockNotifyManagers.mockResolvedValue({ sentTo: 0, skippedNoTelegram: 0, failed: 2 })

    const result = await requestDeliveryOverride({
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: 'Клиент у соседнего входа',
    })

    expect(mockCreateOverrideCore).toHaveBeenCalledWith(courier, {
      stopId: 'stop-1',
      geoAttemptId: 'attempt-1',
      comment: 'Клиент у соседнего входа',
      now: current,
    })
    expect(mockOverrideFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'override-1' },
    }))
    expect(mockNotifyManagers).toHaveBeenCalledOnce()
    expect(mockCreateOverrideCore.mock.invocationCallOrder[0])
      .toBeLessThan(mockNotifyManagers.mock.invocationCallOrder[0])
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        requestId: 'override-1',
        status: 'PENDING',
        notificationFailed: true,
      }),
    })
  })
})

describe('completeRouteStopAsManager', () => {
  it('requires manager role and delegates only validated stop data', async () => {
    const current = new Date('2026-08-12T08:00:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(manager)
    mockManagerCompleteCore.mockResolvedValue({
      stopId: 'stop-1',
      delivered: true,
      idempotent: false,
      version: 4,
      completionMethod: 'MANAGER_DIRECT',
    })

    const result = await completeRouteStopAsManager({
      stopId: 'stop-1',
      expectedVersion: 3,
      reason: 'Позвонили клиенту',
    })

    expect(mockRequireRole).toHaveBeenCalledWith(['ADMIN', 'MANAGER'])
    expect(mockManagerCompleteCore).toHaveBeenCalledWith(manager, {
      stopId: 'stop-1',
      expectedVersion: 3,
      reason: 'Позвонили клиенту',
      now: current,
    })
    expect(result.ok).toBe(true)
  })
})

describe('resolveDeliveryOverrideAsManager', () => {
  it('uses the authenticated manager and never accepts an actor from the client', async () => {
    const current = new Date('2026-08-12T08:00:00.000Z')
    vi.setSystemTime(current)
    mockRequireRole.mockResolvedValue(manager)
    mockResolveOverrideCore.mockResolvedValue({
      requestId: 'override-1',
      status: 'APPROVED',
      stopDelivered: true,
      idempotent: false,
    })

    const result = await resolveDeliveryOverrideAsManager({
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: 'Подтверждено по звонку',
    })

    expect(mockRequireRole).toHaveBeenCalledWith(['ADMIN', 'MANAGER'])
    expect(mockResolveOverrideCore).toHaveBeenCalledWith(manager, {
      requestId: 'override-1',
      decision: 'APPROVE',
      comment: 'Подтверждено по звонку',
      now: current,
    })
    expect(mockRevalidatePath).toHaveBeenCalledWith('/delivery/control')
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ status: 'APPROVED', stopDelivered: true }),
    })
  })

  it('rejects malformed resolution before the Core', async () => {
    mockRequireRole.mockResolvedValue(manager)
    const result = await resolveDeliveryOverrideAsManager({
      requestId: '',
      decision: 'REJECT',
      comment: null,
    })
    expect(result.ok).toBe(false)
    expect(mockResolveOverrideCore).not.toHaveBeenCalled()
  })
})
