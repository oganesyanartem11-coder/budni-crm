import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockEnsure,
  mockGetManagerControl,
  mockRequireRole,
} = vi.hoisted(() => ({
  mockEnsure: vi.fn(),
  mockGetManagerControl: vi.fn(),
  mockRequireRole: vi.fn(),
}))

vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/delivery/route-materializer', () => ({
  ensureCourierRouteStopsForDate: mockEnsure,
}))
vi.mock('@/lib/delivery/manager-control-read-model', () => ({
  getManagerDeliveryControl: mockGetManagerControl,
}))
vi.mock('./_components/manager-control-screen', () => ({
  ManagerControlScreen: () => null,
}))

import DeliveryControlPage from './control/page'

const NOW = new Date('2026-08-21T15:25:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  mockRequireRole.mockResolvedValue({ id: 'manager-1', role: 'MANAGER' })
  mockEnsure.mockResolvedValue({})
  mockGetManagerControl.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('manager delivery control route guards', () => {
  it.each([
    './control/page.tsx',
    './control/[routeDayId]/page.tsx',
    './control/analytics/page.tsx',
  ])('%s is server-guarded for manager roles only', (file) => {
    const page = source(file)
    expect(page).toContain("requireRole(['ADMIN_PRO', 'ADMIN', 'MANAGER'])")
    expect(page).not.toContain("'COURIER'")
    expect(page).not.toContain("'CHEF'")
  })

  it('loads today control through the read-only manager model', () => {
    const page = source('./control/page.tsx')
    expect(page).toContain('getManagerDeliveryControl')
    expect(page).toContain('getMskCalendarDayUtc')
  })

  it('materializes today after authorization and before reading manager control', async () => {
    await DeliveryControlPage()

    const today = new Date('2026-08-21T00:00:00.000Z')
    expect(mockEnsure).toHaveBeenCalledWith(today, NOW)
    expect(mockRequireRole.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnsure.mock.invocationCallOrder[0],
    )
    expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetManagerControl.mock.invocationCallOrder[0],
    )
    expect(mockGetManagerControl).toHaveBeenCalledWith(
      { id: 'manager-1', role: 'MANAGER' },
      today,
      NOW,
    )
  })

  it('awaits dynamic params and delegates foreign stop validation to the route model', () => {
    const page = source('./control/[routeDayId]/page.tsx')
    expect(page).toContain('params: Promise<{ routeDayId: string }>')
    expect(page).toContain('searchParams: Promise<{ stop?: string }>')
    expect(page).toContain('getManagerCourierRouteDetail')
    expect(page).toContain('notFound()')
  })

  it('resolves the analytics period server-side and reads stop analytics', () => {
    const page = source('./control/analytics/page.tsx')
    expect(page).toContain('resolveDeliveryAnalyticsPeriod')
    expect(page).toContain('getManagerDeliveryAnalytics')
  })
})
