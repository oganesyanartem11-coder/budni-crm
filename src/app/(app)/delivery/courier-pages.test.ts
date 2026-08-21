import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireRole,
  mockGetLegacyDeliveries,
  mockGetOwnRoute,
  mockGetOwnStop,
  mockNotFound,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetLegacyDeliveries: vi.fn(),
  mockGetOwnRoute: vi.fn(),
  mockGetOwnStop: vi.fn(),
  mockNotFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))

vi.mock('@/lib/auth/current-user', () => ({ requireRole: mockRequireRole }))
vi.mock('@/lib/db/queries/deliveries', () => ({ getDeliveriesForDate: mockGetLegacyDeliveries }))
vi.mock('@/lib/delivery/courier-route-read-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/delivery/courier-route-read-model')>()
  return {
    ...actual,
    getOwnCourierRouteDay: mockGetOwnRoute,
    getOwnCourierRouteStop: mockGetOwnStop,
  }
})
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => createElement('header', null, title),
}))
vi.mock('./delivery-view', () => ({
  DeliveryView: () => createElement('div', { 'data-view': 'legacy-delivery' }),
}))
vi.mock('./_components/courier-route-screen', () => ({
  CourierRouteScreen: ({ route }: { route: { id: string } | null }) =>
    createElement('div', { 'data-view': 'courier-route' }, route?.id ?? 'empty'),
}))
vi.mock('./_components/courier-stop-screen', () => ({
  CourierStopScreen: ({
    stop,
    nextStopId,
  }: {
    stop: { id: string }
    nextStopId: string | null
  }) => createElement('div', { 'data-view': 'courier-stop' }, `${stop.id}:${nextStopId ?? 'none'}`),
}))

import DeliveryPage from './page'
import CourierStopPage from './stops/[stopId]/page'
import { CourierRouteReadAccessError } from '@/lib/delivery/courier-route-read-model'

describe('delivery courier pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLegacyDeliveries.mockResolvedValue([])
    mockGetOwnRoute.mockResolvedValue(null)
  })

  it('renders the read-only own route for a courier and skips the legacy query', async () => {
    const courier = { id: 'courier-1', name: 'Иван', role: 'COURIER' as const }
    mockRequireRole.mockResolvedValue(courier)
    mockGetOwnRoute.mockResolvedValue({ id: 'route-1' })

    const html = renderToStaticMarkup(await DeliveryPage({ searchParams: Promise.resolve({}) }))

    expect(mockGetOwnRoute).toHaveBeenCalledWith(courier, expect.any(Date), expect.any(Date))
    expect(mockGetLegacyDeliveries).not.toHaveBeenCalled()
    expect(html).toContain('data-view="courier-route"')
    expect(html).toContain('route-1')
  })

  it('keeps the existing summary for managers until the control screen lands', async () => {
    mockRequireRole.mockResolvedValue({ id: 'manager-1', name: 'Мария', role: 'MANAGER' })

    const html = renderToStaticMarkup(await DeliveryPage({ searchParams: Promise.resolve({}) }))

    expect(mockGetLegacyDeliveries).toHaveBeenCalledOnce()
    expect(mockGetOwnRoute).not.toHaveBeenCalled()
    expect(html).toContain('data-view="legacy-delivery"')
  })

  it('loads an own stop and computes the following open stop', async () => {
    const courier = { id: 'courier-1', name: 'Иван', role: 'COURIER' as const }
    mockRequireRole.mockResolvedValue(courier)
    mockGetOwnStop.mockResolvedValue({
      id: 'stop-current',
      deliveryDate: new Date('2026-08-21T00:00:00.000Z'),
      deliveredAt: null,
    })
    mockGetOwnRoute.mockResolvedValue({
      totalStops: 3,
      deliveredStops: 1,
      remainingStops: 2,
      nextStop: { id: 'stop-current' },
      otherStops: [{ id: 'stop-next' }],
    })

    const html = renderToStaticMarkup(await CourierStopPage({
      params: Promise.resolve({ stopId: 'stop-current' }),
    }))

    expect(mockGetOwnStop).toHaveBeenCalledWith(courier, 'stop-current', expect.any(Date))
    expect(html).toContain('data-view="courier-stop"')
    expect(html).toContain('stop-current:stop-next')
  })

  it('returns not-found for a foreign stop without rendering its data', async () => {
    mockRequireRole.mockResolvedValue({ id: 'courier-1', name: 'Иван', role: 'COURIER' })
    mockGetOwnStop.mockRejectedValue(new CourierRouteReadAccessError())

    await expect(CourierStopPage({
      params: Promise.resolve({ stopId: 'foreign-stop' }),
    })).rejects.toThrow('NEXT_NOT_FOUND')

    expect(mockNotFound).toHaveBeenCalledOnce()
    expect(mockGetOwnRoute).not.toHaveBeenCalled()
  })
})
