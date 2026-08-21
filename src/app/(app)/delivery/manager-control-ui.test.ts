import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./_components/route-refresh-control', () => ({
  RouteRefreshControl: ({ label }: { label?: string }) => createElement('button', null, label),
}))
vi.mock('./_components/manager-stop-actions', () => ({
  ManagerStopActions: () => createElement('div', null, 'Manager stop actions'),
}))

import { ManagerAnalyticsScreen } from './_components/manager-analytics-screen'
import { ManagerControlScreen } from './_components/manager-control-screen'
import { ManagerRouteDetailScreen } from './_components/manager-route-detail-screen'
import type { DeliveryAnalyticsSummary } from '@/lib/delivery/delivery-analytics'
import type {
  ManagerCourierRouteDetailView,
  ManagerDeliveryControlView,
} from '@/lib/delivery/manager-control-read-model'

const date = new Date('2026-08-21T00:00:00.000Z')

function summaryStop(over: Record<string, unknown> = {}) {
  return {
    id: 'stop-1',
    routeDayId: 'route-1',
    version: 1,
    state: 'LATE' as const,
    assignmentMode: 'IN_HOUSE' as const,
    clientName: 'СтройПарк',
    locationName: 'Башня А',
    locationAddress: 'Москва, Пресненская набережная, 8',
    deliveryWindowFrom: '10:00',
    deliveryWindowTo: '10:30',
    assignedAt: new Date('2026-08-21T06:00:00.000Z'),
    deliveredAt: null,
    totalPortions: 20,
    pendingOverride: false,
    ...over,
  }
}

describe('ManagerControlScreen', () => {
  it('makes every today-control answer visible without opening a route', () => {
    const data: ManagerDeliveryControlView = {
      deliveryDate: date,
      summary: {
        workingCouriers: 2,
        totalStops: 5,
        deliveredStops: 1,
        activeLateStops: 1,
        externalStops: 1,
        unassignedStops: 1,
        pendingOverrides: 1,
      },
      couriers: [{
        routeDayId: 'route-1',
        courierId: 'courier-1',
        courierName: 'Иван Петров',
        initials: 'ИП',
        state: 'IN_PROGRESS',
        startedAt: new Date('2026-08-21T05:30:00.000Z'),
        completedAt: null,
        totalStops: 3,
        deliveredStops: 1,
        remainingStops: 2,
        activeLateStops: 1,
        newStops: 1,
        pendingOverrides: 1,
        nextStop: summaryStop(),
        lastAction: {
          kind: 'GPS_CHECK',
          at: new Date('2026-08-21T11:50:00.000Z'),
          stopId: 'stop-1',
          locationName: 'Башня А',
        },
      }],
      externalStops: [summaryStop({
        id: 'external',
        routeDayId: null,
        assignmentMode: 'EXTERNAL',
        state: 'PLANNED',
      })],
      unassignedStops: [summaryStop({
        id: 'unassigned',
        routeDayId: null,
        assignmentMode: 'UNASSIGNED',
        state: 'PLANNED',
      })],
    }

    const html = renderToStaticMarkup(createElement(ManagerControlScreen, { data }))
    expect(html).toContain('Контроль доставки')
    expect(html).toContain('Курьеры на маршруте')
    expect(html).toContain('Всего точек')
    expect(html).toContain('Опаздывают')
    expect(html).toContain('InDrive')
    expect(html).toContain('Не назначено')
    expect(html).toContain('Ждут решения')
    expect(html).toContain('Иван Петров')
    expect(html).toContain('Следующая точка')
    expect(html).toContain('Последнее действие')
    expect(html).toContain('href="/delivery/control/route-1"')
    expect(html).toContain('Иван Петров: выполнено 1 из 3; опаздывают 1; ждут решения 1; открыть маршрут')
  })

  it('keeps five couriers compact on mobile and limits desktop to two rows', () => {
    const couriers: ManagerDeliveryControlView['couriers'] = Array.from({ length: 5 }, (_, index) => ({
      routeDayId: `route-${index + 1}`,
      courierId: `courier-${index + 1}`,
      courierName: `Курьер ${index + 1}`,
      initials: `К${index + 1}`,
      state: 'IN_PROGRESS',
      startedAt: new Date('2026-08-21T05:30:00.000Z'),
      completedAt: null,
      totalStops: 4,
      deliveredStops: index % 3,
      remainingStops: 4 - (index % 3),
      activeLateStops: index === 0 ? 2 : 0,
      newStops: index === 1 ? 1 : 0,
      pendingOverrides: index === 0 ? 1 : 0,
      nextStop: summaryStop({ id: `stop-${index + 1}` }),
      lastAction: null,
    }))
    const data: ManagerDeliveryControlView = {
      deliveryDate: date,
      summary: {
        workingCouriers: 5,
        totalStops: 20,
        deliveredStops: 4,
        activeLateStops: 2,
        externalStops: 0,
        unassignedStops: 0,
        pendingOverrides: 1,
      },
      couriers,
      externalStops: [],
      unassignedStops: [],
    }

    const html = renderToStaticMarkup(createElement(ManagerControlScreen, { data }))

    expect(html.match(/href="\/delivery\/control\/route-/g)).toHaveLength(5)
    expect(html).toContain('gap-3 sm:gap-4 lg:grid-cols-2 xl:grid-cols-3')
    expect(html).toContain('p-4 sm:p-5')
    expect(html).toContain('href="#courier-routes"')
    expect(html).toContain('К курьерам · 5')
    expect(html).toContain('grid grid-cols-2 gap-2')
    expect(html).toContain('Курьер 1: выполнено 0 из 4; опаздывают 2; ждут решения 1; открыть маршрут')
    expect(html).toContain('Курьер 5')
  })
})

describe('ManagerRouteDetailScreen', () => {
  it('shows ordered stops, selection, geo, override and timeline', () => {
    const selected = {
      ...summaryStop(),
      contactName: 'Алексей',
      contactPhone: '+79990000000',
      contactNotes: 'Позвонить заранее',
      deliveryInstructions: 'Въезд через КПП',
      geofenceEnabled: true,
      geofenceRadiusM: 1_000,
      items: [{
        id: 'order-1',
        mealType: 'LUNCH' as const,
        portions: 20,
        packaging: 'INDIVIDUAL' as const,
        tags: [],
        notes: null,
      }],
      latestGeoAttempt: {
        id: 'geo-1',
        result: 'OUTSIDE_GEOFENCE' as const,
        distanceM: 1_250,
        accuracyM: 30,
        receivedAt: new Date('2026-08-21T11:50:00.000Z'),
      },
      override: {
        id: 'override-1',
        geoAttemptId: 'geo-1',
        status: 'PENDING' as const,
        comment: 'Охрана не пускает',
        expiresAt: new Date('2026-08-21T12:15:00.000Z'),
        createdAt: new Date('2026-08-21T11:55:00.000Z'),
        resolvedAt: null,
        resolvedByName: null,
        resolutionComment: null,
      },
      timeline: [{
        id: 'geo-geo-1',
        kind: 'GPS_CHECK' as const,
        at: new Date('2026-08-21T11:50:00.000Z'),
        title: 'GPS-проверка',
        detail: 'Вне геозоны · 1250 м',
      }],
    }
    const data = {
      route: {
        routeDayId: 'route-1',
        courierId: 'courier-1',
        courierName: 'Иван Петров',
        initials: 'ИП',
        state: 'IN_PROGRESS',
        startedAt: new Date('2026-08-21T05:30:00.000Z'),
        completedAt: null,
        totalStops: 1,
        deliveredStops: 0,
        remainingStops: 1,
        activeLateStops: 1,
        newStops: 0,
        pendingOverrides: 1,
        nextStop: summaryStop(),
        lastAction: null,
      },
      stops: [summaryStop({ pendingOverride: true })],
      selectedStop: selected,
      couriers: [{ id: 'courier-1', name: 'Иван Петров' }],
    } as ManagerCourierRouteDetailView

    const html = renderToStaticMarkup(createElement(ManagerRouteDetailScreen, { data }))
    expect(html).toContain('Маршрут курьера')
    expect(html).toContain('Иван Петров')
    expect(html).toContain('Точки маршрута')
    expect(html).toContain('Башня А')
    expect(html).toContain('GPS-проверка')
    expect(html).toContain('Вне геозоны')
    expect(html).not.toContain('OUTSIDE_GEOFENCE')
    expect(html).toContain('Охрана не пускает')
    expect(html).toContain('Хронология')
    expect(html).toContain('Manager stop actions')
    expect(html.match(/Ждёт решения/g)).toHaveLength(2)
    expect(html).toContain('order-2')
    expect(html).not.toContain('xl:order-')
    expect(html.indexOf('id="selected-stop-title"')).toBeLessThan(html.indexOf('id="route-stops-title"'))
  })
})

describe('ManagerAnalyticsScreen', () => {
  it('shows all stop-based metrics, period controls and the Delivery 2.0 explanation', () => {
    const analytics: DeliveryAnalyticsSummary = {
      overall: {
        physicalDeliveries: 12,
        punctualityEligible: 10,
        onTime: 8,
        late: 2,
        onTimePercent: 80,
        averageDelayMinutes: 37,
        maxDelayMinutes: 55,
        overrides: 1,
      },
      couriers: [{
        courierId: 'courier-1',
        courierName: 'Иван Петров',
        physicalDeliveries: 8,
        punctualityEligible: 7,
        onTime: 6,
        late: 1,
        onTimePercent: 85.7,
        averageDelayMinutes: 35,
        maxDelayMinutes: 35,
        overrides: 1,
      }],
    }
    const html = renderToStaticMarkup(createElement(ManagerAnalyticsScreen, {
      analytics,
      period: { kind: '7d', from: new Date('2026-08-15T00:00:00.000Z'), to: date },
    }))

    expect(html).toContain('Аналитика доставки')
    expect(html).toContain('Сегодня')
    expect(html).toContain('7 дней')
    expect(html).toContain('30 дней')
    expect(html).toContain('Период')
    expect(html).toContain('Физические доставки')
    expect(html).toContain('Вовремя, %')
    expect(html).toContain('Средняя задержка')
    expect(html).toContain('Максимальная задержка')
    expect(html).toContain('Overrides')
    expect(html).toContain('Статистика по курьерам собирается с запуска Delivery 2.0')
    expect(html).toContain('Иван Петров')
  })
})
