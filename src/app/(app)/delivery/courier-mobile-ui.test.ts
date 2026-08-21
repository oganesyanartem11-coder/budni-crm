import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('./route-actions', () => ({
  startOwnCourierRoute: vi.fn(),
  completeOwnRouteStop: vi.fn(),
  requestDeliveryOverride: vi.fn(),
}))
vi.mock('./_components/issue-dialog', () => ({
  IssueDialog: () => null,
}))

import { CourierRouteScreen } from './_components/courier-route-screen'
import { CourierStopScreen } from './_components/courier-stop-screen'
import type {
  CourierRouteDayView,
  CourierRouteStopView,
} from '@/lib/delivery/courier-route-read-model'

const date = new Date('2026-08-21T00:00:00.000Z')

function stop(over: Partial<CourierRouteStopView> = {}): CourierRouteStopView {
  return {
    id: 'stop-1',
    routeDayId: 'route-1',
    deliveryDate: date,
    version: 2,
    state: 'PLANNED',
    clientName: 'СтальСтройМонтаж',
    locationName: 'Аэропорт',
    locationAddress: 'ул. Аэропортовская, 12',
    contactName: 'Анна',
    contactPhone: '+79991234567',
    contactNotes: 'Встретит у шлагбаума',
    deliveryWindowFrom: '10:00',
    deliveryWindowTo: '11:00',
    deliveryInstructions: 'Въезд через вторые ворота',
    assignedAt: new Date('2026-08-21T05:00:00.000Z'),
    deliveredAt: null,
    completionMethod: null,
    totalPortions: 12,
    items: [{
      orderId: 'order-1',
      mealType: 'LUNCH',
      portions: 12,
      packaging: 'INDIVIDUAL',
      tags: ['Без свинины'],
      notes: 'Два прибора отдельно',
    }],
    tags: ['Без свинины'],
    notes: ['Два прибора отдельно'],
    geofence: { enabled: true, radiusM: 1_000, hasCoordinates: true },
    latestGeoAttempt: null,
    override: null,
    route: { id: 'route-1', started: true, completed: false },
    ...over,
  }
}

function route(over: Partial<CourierRouteDayView> = {}): CourierRouteDayView {
  const nextStop = stop()
  const delivered = stop({
    id: 'stop-done',
    locationName: 'ТЭЦ',
    state: 'DELIVERED',
    deliveredAt: new Date('2026-08-21T06:30:00.000Z'),
    completionMethod: 'GEOFENCE',
  })
  const other = stop({ id: 'stop-other', locationName: 'Шоссейная' })
  return {
    id: 'route-1',
    deliveryDate: date,
    courierName: 'Иван Петров',
    startedAt: new Date('2026-08-21T05:30:00.000Z'),
    completedAt: null,
    routeChangedAt: null,
    state: 'IN_PROGRESS',
    totalStops: 3,
    deliveredStops: 1,
    remainingStops: 2,
    totalPortions: 36,
    deliveredPortions: 12,
    nextStop,
    otherStops: [other],
    completedStops: [delivered],
    newStops: [],
    hasRouteChanges: false,
    ...over,
  }
}

describe('CourierRouteScreen', () => {
  it('renders progress, unchanged status and next/other/delivered groups', () => {
    const html = renderToStaticMarkup(createElement(CourierRouteScreen, { route: route() }))

    expect(html).toContain('Маршрут на сегодня')
    expect(html).toContain('1 из 3')
    expect(html).toContain('Осталось 2')
    expect(html).toContain('Маршрут без изменений')
    expect(html).toContain('Следующая точка')
    expect(html).toContain('Аэропорт')
    expect(html).toContain('Остальные')
    expect(html).toContain('Шоссейная')
    expect(html).toContain('Доставлено')
    expect(html).toContain('ТЭЦ')
    expect(html).toContain('href="/delivery/stops/stop-1"')
  })

  it('shows start-route and new-stop states', () => {
    const newStop = stop({ id: 'new-stop', state: 'NEW', locationName: 'Новая площадка' })
    const html = renderToStaticMarkup(createElement(CourierRouteScreen, {
      route: route({
        startedAt: null,
        state: 'NOT_STARTED',
        nextStop: newStop,
        otherStops: [],
        newStops: [newStop],
        hasRouteChanges: true,
      }),
    }))

    expect(html).toContain('Начать маршрут')
    expect(html).toContain('Новые точки')
    expect(html).toContain('Новая площадка')
  })
})

describe('CourierStopScreen', () => {
  it('renders one full stop with operational details and one delivery CTA', () => {
    const html = renderToStaticMarkup(createElement(CourierStopScreen, {
      stop: stop(),
      nextStopId: 'stop-next',
    }))

    expect(html).toContain('Все точки')
    expect(html).toContain('10:00–11:00')
    expect(html).toContain('СтальСтройМонтаж')
    expect(html).toContain('Аэропорт')
    expect(html).toContain('Анна')
    expect(html).toContain('href="tel:+79991234567"')
    expect(html).toContain('Встретит у шлагбаума')
    expect(html).toContain('Въезд через вторые ворота')
    expect(html).toContain('ул. Аэропортовская, 12')
    expect(html).toContain('yandex.ru/maps')
    expect(html).toContain('Обед')
    expect(html).toContain('Индивидуальная')
    expect(html).toContain('12 порций')
    expect(html).toContain('Без свинины')
    expect(html).toContain('Два прибора отдельно')
    expect(html).toContain('Подтвердить доставку')
    expect(html).toContain('Не смог доставить')
  })

  it('renders only server-confirmed delivery success with next and all links', () => {
    const html = renderToStaticMarkup(createElement(CourierStopScreen, {
      stop: stop({
        state: 'DELIVERED',
        deliveredAt: new Date('2026-08-21T07:00:00.000Z'),
        completionMethod: 'GEOFENCE',
      }),
      nextStopId: 'stop-next',
    }))

    expect(html).toContain('Доставка подтверждена')
    expect(html).toContain('Следующая точка')
    expect(html).toContain('href="/delivery/stops/stop-next"')
    expect(html).toContain('href="/delivery"')
    expect(html).not.toContain('Подтвердить доставку')
  })

  it('explains a persisted pending override state', () => {
    const html = renderToStaticMarkup(createElement(CourierStopScreen, {
      stop: stop({
        override: {
          id: 'override-1',
          status: 'PENDING',
          expiresAt: new Date('2026-08-21T08:00:00.000Z'),
          createdAt: new Date('2026-08-21T07:45:00.000Z'),
          resolutionComment: null,
        },
      }),
      nextStopId: null,
    }))

    expect(html).toContain('Решение менеджера ожидается')
    expect(html).not.toContain('Доставка подтверждена')
  })
})
