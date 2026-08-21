import { describe, expect, it } from 'vitest'
import {
  compareRouteStops,
  getRouteState,
  getStopState,
  isNewRouteStop,
  normalizeMskDeliveryDate,
} from './route-domain'

const deliveryDate = new Date('2026-08-11T00:00:00.000Z')

describe('daily route domain', () => {
  it('derives route state only from timestamps', () => {
    expect(getRouteState({ startedAt: null, completedAt: null })).toBe('NOT_STARTED')
    expect(
      getRouteState({
        startedAt: new Date('2026-08-11T06:00:00.000Z'),
        completedAt: null,
      }),
    ).toBe('IN_PROGRESS')
    expect(
      getRouteState({
        startedAt: new Date('2026-08-11T06:00:00.000Z'),
        completedAt: new Date('2026-08-11T10:00:00.000Z'),
      }),
    ).toBe('COMPLETED')
  })

  it('considers a stop new only when assigned after route start', () => {
    const route = { startedAt: new Date('2026-08-11T06:00:00.000Z') }

    expect(
      isNewRouteStop(
        { assignedAt: new Date('2026-08-11T06:00:00.001Z') },
        route,
      ),
    ).toBe(true)
    expect(
      isNewRouteStop(
        { assignedAt: new Date('2026-08-11T06:00:00.000Z') },
        route,
      ),
    ).toBe(false)
    expect(isNewRouteStop({ assignedAt: new Date() }, { startedAt: null })).toBe(false)
  })

  it('marks an active stop late only after window end plus 20 minutes', () => {
    const stop = {
      assignedAt: new Date('2026-08-11T05:00:00.000Z'),
      deliveredAt: null,
      cancelledAt: null,
      deliveryWindowToSnapshot: '12:00',
      deliveryDate,
    }
    const route = { startedAt: new Date('2026-08-11T06:00:00.000Z') }

    expect(
      getStopState(stop, route, new Date('2026-08-11T09:20:00.000Z')),
    ).toBe('PLANNED')
    expect(
      getStopState(stop, route, new Date('2026-08-11T09:20:00.001Z')),
    ).toBe('LATE')
  })

  it('gives cancelled and delivered precedence over late/new', () => {
    const route = { startedAt: new Date('2026-08-11T06:00:00.000Z') }
    const base = {
      assignedAt: new Date('2026-08-11T07:00:00.000Z'),
      deliveryWindowToSnapshot: '08:00',
      deliveryDate,
    }

    expect(
      getStopState(
        { ...base, cancelledAt: new Date(), deliveredAt: null },
        route,
        new Date('2026-08-11T12:00:00.000Z'),
      ),
    ).toBe('CANCELLED')
    expect(
      getStopState(
        { ...base, cancelledAt: null, deliveredAt: new Date() },
        route,
        new Date('2026-08-11T12:00:00.000Z'),
      ),
    ).toBe('DELIVERED')
  })

  it('orders active stops by window, then delivered and cancelled stops', () => {
    const rows = [
      { id: 'cancelled', deliveryWindowFromSnapshot: '08:00', deliveredAt: null, cancelledAt: new Date(), locationNameSnapshot: 'А' },
      { id: 'no-window', deliveryWindowFromSnapshot: null, deliveredAt: null, cancelledAt: null, locationNameSnapshot: 'Я' },
      { id: 'delivered', deliveryWindowFromSnapshot: '07:00', deliveredAt: new Date(), cancelledAt: null, locationNameSnapshot: 'Б' },
      { id: 'later', deliveryWindowFromSnapshot: '11:00', deliveredAt: null, cancelledAt: null, locationNameSnapshot: 'В' },
      { id: 'early', deliveryWindowFromSnapshot: '09:00', deliveredAt: null, cancelledAt: null, locationNameSnapshot: 'Г' },
    ]

    expect([...rows].sort(compareRouteStops).map((row) => row.id)).toEqual([
      'early',
      'later',
      'no-window',
      'delivered',
      'cancelled',
    ])
  })

  it('normalizes moments around the UTC/MSK date boundary to @db.Date', () => {
    expect(normalizeMskDeliveryDate(new Date('2026-08-10T20:59:59.999Z')))
      .toEqual(new Date('2026-08-10T00:00:00.000Z'))
    expect(normalizeMskDeliveryDate(new Date('2026-08-10T21:00:00.000Z')))
      .toEqual(new Date('2026-08-11T00:00:00.000Z'))
  })
})
