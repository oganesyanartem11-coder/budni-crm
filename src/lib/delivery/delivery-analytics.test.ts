import { describe, expect, it } from 'vitest'
import {
  resolveDeliveryAnalyticsPeriod,
  summarizeDeliveryAnalytics,
} from './delivery-analytics'

const deliveryDate = new Date('2026-08-11T00:00:00.000Z')

function stop(over: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    deliveryDate,
    assignmentMode: 'IN_HOUSE' as const,
    cancelledAt: null,
    deliveredAt: new Date('2026-08-11T07:20:00.000Z'),
    deliveryWindowToSnapshot: '10:00',
    completionMethod: 'GEOFENCE' as const,
    routeDay: {
      courierId: 'courier-1',
      courierNameSnapshot: 'Иван Петров',
    },
    ...over,
  }
}

describe('delivery analytics period', () => {
  const now = new Date('2026-08-21T12:00:00.000Z')

  it.each([
    ['today', '2026-08-21', '2026-08-21'],
    ['7d', '2026-08-15', '2026-08-21'],
    ['30d', '2026-07-23', '2026-08-21'],
  ] as const)('resolves %s as an inclusive MSK date period', (range, from, to) => {
    const result = resolveDeliveryAnalyticsPeriod({ range }, now)
    expect(result.from.toISOString().slice(0, 10)).toBe(from)
    expect(result.to.toISOString().slice(0, 10)).toBe(to)
  })

  it('accepts a valid custom period and safely falls back for invalid input', () => {
    const custom = resolveDeliveryAnalyticsPeriod({
      range: 'period',
      from: '2026-08-01',
      to: '2026-08-10',
    }, now)
    expect(custom).toMatchObject({ kind: 'period' })
    expect(custom.from.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(custom.to.toISOString()).toBe('2026-08-10T00:00:00.000Z')

    const fallback = resolveDeliveryAnalyticsPeriod({
      range: 'period',
      from: '2026-08-20',
      to: 'not-a-date',
    }, now)
    expect(fallback.kind).toBe('today')
  })
})

describe('summarizeDeliveryAnalytics', () => {
  it('counts physical stops, excludes no-window only from punctuality and keeps InDrive overall', () => {
    const result = summarizeDeliveryAnalytics([
      stop({ id: 'courier-on-time' }),
      stop({
        id: 'courier-late',
        deliveredAt: new Date('2026-08-11T07:31:00.000Z'),
      }),
      stop({
        id: 'external-late',
        assignmentMode: 'EXTERNAL',
        deliveredAt: new Date('2026-08-11T07:45:00.000Z'),
        completionMethod: 'MANAGER_DIRECT',
        routeDay: null,
      }),
      stop({
        id: 'unassigned-no-window',
        assignmentMode: 'UNASSIGNED',
        deliveryWindowToSnapshot: null,
        completionMethod: 'MANAGER_OVERRIDE',
        routeDay: null,
      }),
      stop({
        id: 'legacy-no-current-courier',
        deliveredAt: new Date('2026-08-11T06:50:00.000Z'),
        routeDay: null,
      }),
      stop({
        id: 'cancelled',
        cancelledAt: new Date('2026-08-11T06:00:00.000Z'),
      }),
    ])

    expect(result.overall).toEqual({
      physicalDeliveries: 5,
      punctualityEligible: 4,
      onTime: 2,
      late: 2,
      onTimePercent: 50,
      averageDelayMinutes: 38,
      maxDelayMinutes: 45,
      overrides: 1,
    })
    expect(result.couriers).toEqual([expect.objectContaining({
      courierId: 'courier-1',
      courierName: 'Иван Петров',
      physicalDeliveries: 2,
      onTime: 1,
      late: 1,
    })])
    expect(result.couriers.some((row) => row.courierId === 'external')).toBe(false)
  })

  it('does not classify open stops as completed physical deliveries', () => {
    const result = summarizeDeliveryAnalytics([
      stop({ deliveredAt: null, completionMethod: null }),
    ])
    expect(result.overall.physicalDeliveries).toBe(0)
    expect(result.overall.onTimePercent).toBeNull()
  })
})
