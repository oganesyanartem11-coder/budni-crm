import type {
  CourierAssignmentMode,
  CourierStopCompletionMethod,
} from '@prisma/client'
import { evaluateDeliveryLate } from '@/lib/delivery/delivery-late'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

export type DeliveryAnalyticsPeriodKind = 'today' | '7d' | '30d' | 'period'

export interface DeliveryAnalyticsPeriod {
  kind: DeliveryAnalyticsPeriodKind
  from: Date
  to: Date
}

export interface DeliveryAnalyticsPeriodInput {
  range?: string
  from?: string
  to?: string
}

export interface DeliveryAnalyticsStopInput {
  id: string
  deliveryDate: Date
  assignmentMode: CourierAssignmentMode
  cancelledAt: Date | null
  deliveredAt: Date | null
  deliveryWindowToSnapshot: string | null
  completionMethod: CourierStopCompletionMethod | null
  routeDay: {
    courierId: string
    courierNameSnapshot: string
  } | null
}

export interface DeliveryAnalyticsMetrics {
  physicalDeliveries: number
  punctualityEligible: number
  onTime: number
  late: number
  onTimePercent: number | null
  averageDelayMinutes: number | null
  maxDelayMinutes: number | null
  overrides: number
}

export interface CourierDeliveryAnalytics extends DeliveryAnalyticsMetrics {
  courierId: string
  courierName: string
}

export interface DeliveryAnalyticsSummary {
  overall: DeliveryAnalyticsMetrics
  couriers: CourierDeliveryAnalytics[]
}

function parseDateOnly(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10) === value ? date : null
}

export function resolveDeliveryAnalyticsPeriod(
  input: DeliveryAnalyticsPeriodInput,
  now = new Date(),
): DeliveryAnalyticsPeriod {
  const today = getMskCalendarDayUtc(now)
  if (input.range === '7d') {
    return { kind: '7d', from: getMskCalendarDayUtc(now, -6), to: today }
  }
  if (input.range === '30d') {
    return { kind: '30d', from: getMskCalendarDayUtc(now, -29), to: today }
  }
  if (input.range === 'period') {
    const from = parseDateOnly(input.from)
    const to = parseDateOnly(input.to)
    if (from && to && from.getTime() <= to.getTime()) {
      return { kind: 'period', from, to }
    }
  }
  return { kind: 'today', from: today, to: today }
}

interface MutableMetrics {
  physicalDeliveries: number
  punctualityEligible: number
  onTime: number
  late: number
  lateDelays: number[]
  overrides: number
}

function emptyMetrics(): MutableMetrics {
  return {
    physicalDeliveries: 0,
    punctualityEligible: 0,
    onTime: 0,
    late: 0,
    lateDelays: [],
    overrides: 0,
  }
}

function addStop(metrics: MutableMetrics, stop: DeliveryAnalyticsStopInput): void {
  if (stop.cancelledAt || !stop.deliveredAt) return
  metrics.physicalDeliveries += 1
  if (stop.completionMethod === 'MANAGER_OVERRIDE') metrics.overrides += 1

  const late = evaluateDeliveryLate(
    stop.deliveryDate,
    stop.deliveryWindowToSnapshot,
    stop.deliveredAt,
  )
  if (late.delayMinutes === null) return

  metrics.punctualityEligible += 1
  if (late.isLate) {
    metrics.late += 1
    metrics.lateDelays.push(late.delayMinutes)
  } else {
    metrics.onTime += 1
  }
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

function finalizeMetrics(metrics: MutableMetrics): DeliveryAnalyticsMetrics {
  const lateTotal = metrics.lateDelays.reduce((sum, value) => sum + value, 0)
  return {
    physicalDeliveries: metrics.physicalDeliveries,
    punctualityEligible: metrics.punctualityEligible,
    onTime: metrics.onTime,
    late: metrics.late,
    onTimePercent: metrics.punctualityEligible === 0
      ? null
      : roundOne((metrics.onTime / metrics.punctualityEligible) * 100),
    averageDelayMinutes: metrics.lateDelays.length === 0
      ? null
      : Math.round(lateTotal / metrics.lateDelays.length),
    maxDelayMinutes: metrics.lateDelays.length === 0
      ? null
      : Math.round(Math.max(...metrics.lateDelays)),
    overrides: metrics.overrides,
  }
}

export function summarizeDeliveryAnalytics(
  stops: DeliveryAnalyticsStopInput[],
): DeliveryAnalyticsSummary {
  const overall = emptyMetrics()
  const courierMetrics = new Map<string, {
    courierName: string
    metrics: MutableMetrics
  }>()

  for (const stop of stops) {
    addStop(overall, stop)
    if (
      stop.assignmentMode !== 'IN_HOUSE'
      || !stop.routeDay
      || stop.cancelledAt
      || !stop.deliveredAt
    ) {
      continue
    }

    const current = courierMetrics.get(stop.routeDay.courierId) ?? {
      courierName: stop.routeDay.courierNameSnapshot,
      metrics: emptyMetrics(),
    }
    addStop(current.metrics, stop)
    courierMetrics.set(stop.routeDay.courierId, current)
  }

  const couriers = [...courierMetrics.entries()]
    .map(([courierId, value]) => ({
      courierId,
      courierName: value.courierName,
      ...finalizeMetrics(value.metrics),
    }))
    .sort((left, right) => left.courierName.localeCompare(right.courierName, 'ru'))

  return { overall: finalizeMetrics(overall), couriers }
}
