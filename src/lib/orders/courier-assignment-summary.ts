import type { MealType } from '@prisma/client'
import { MEAL_TYPE_LABELS } from '@/lib/constants/client'
import { escapeHtml } from '@/lib/telegram/notify'
import { TELEGRAM_MAX_LEN } from '@/lib/telegram/send'
import { formatDateMsk, formatLocations, formatPortions } from '@/lib/utils/format'
import type { CourierAssignmentOrder } from './courier-queries'

const MEAL_TYPE_ORDER: MealType[] = ['BREAKFAST', 'LUNCH', 'DINNER']

export interface CourierStopMeal {
  mealType: MealType
  portions: number
}

export interface CourierStop {
  locationId: string
  locationName: string
  clientName: string
  locationAddress: string
  clientContactPhone: string | null
  deliveryWindowFrom: string | null
  deliveryWindowTo: string | null
  orderIds: string[]
  meals: CourierStopMeal[]
  totalPortions: number
}

export interface CourierAssignmentGroup {
  assignedCourier: { id: string; name: string } | null
  courierLabel: string
  stops: CourierStop[]
  totalPortions: number
  orderCount: number
}

interface MutableStop extends Omit<CourierStop, 'meals'> {
  mealsByType: Map<MealType, number>
}

interface MutableGroup {
  assignedCourier: { id: string; name: string } | null
  courierLabel: string
  stopsByLocation: Map<string, MutableStop>
  orderCount: number
}

function compareStops(a: CourierStop, b: CourierStop): number {
  const aWindow = a.deliveryWindowFrom ?? '99:99'
  const bWindow = b.deliveryWindowFrom ?? '99:99'
  if (aWindow !== bWindow) return aWindow.localeCompare(bWindow)
  return a.locationName.localeCompare(b.locationName, 'ru')
}

/** Чистая группировка: courier → unique location stop → meal breakdown. */
export function groupCourierAssignments(
  orders: CourierAssignmentOrder[],
): CourierAssignmentGroup[] {
  const groups = new Map<string, MutableGroup>()

  for (const order of orders) {
    const groupKey = order.assignedCourier?.id ?? '__indrive__'
    let group = groups.get(groupKey)
    if (!group) {
      group = {
        assignedCourier: order.assignedCourier,
        courierLabel: order.assignedCourier?.name ?? 'InDrive',
        stopsByLocation: new Map(),
        orderCount: 0,
      }
      groups.set(groupKey, group)
    }
    group.orderCount += 1

    let stop = group.stopsByLocation.get(order.locationId)
    if (!stop) {
      stop = {
        locationId: order.locationId,
        locationName: order.locationName,
        clientName: order.clientName,
        locationAddress: order.locationAddress,
        clientContactPhone: order.clientContactPhone,
        deliveryWindowFrom: order.deliveryWindowFrom,
        deliveryWindowTo: order.deliveryWindowTo,
        orderIds: [],
        mealsByType: new Map(),
        totalPortions: 0,
      }
      group.stopsByLocation.set(order.locationId, stop)
    }

    stop.orderIds.push(order.orderId)
    stop.totalPortions += order.portions
    stop.mealsByType.set(
      order.mealType,
      (stop.mealsByType.get(order.mealType) ?? 0) + order.portions,
    )
  }

  return Array.from(groups.values())
    .map((group): CourierAssignmentGroup => {
      const stops = Array.from(group.stopsByLocation.values())
        .map(({ mealsByType, ...stop }): CourierStop => ({
          ...stop,
          meals: MEAL_TYPE_ORDER
            .filter((mealType) => mealsByType.has(mealType))
            .map((mealType) => ({ mealType, portions: mealsByType.get(mealType) ?? 0 })),
        }))
        .sort(compareStops)

      return {
        assignedCourier: group.assignedCourier,
        courierLabel: group.courierLabel,
        stops,
        totalPortions: stops.reduce((sum, stop) => sum + stop.totalPortions, 0),
        orderCount: group.orderCount,
      }
    })
    .sort((a, b) => {
      if (!a.assignedCourier && b.assignedCourier) return 1
      if (a.assignedCourier && !b.assignedCourier) return -1
      return a.courierLabel.localeCompare(b.courierLabel, 'ru')
    })
}

function renderGroupHeader(group: CourierAssignmentGroup): string {
  const label = group.assignedCourier
    ? escapeHtml(group.assignedCourier.name)
    : 'InDrive / не назначено'
  return `<b>${label}</b> — ${formatLocations(group.stops.length)}, ${formatPortions(group.totalPortions)}`
}

function renderStop(stop: CourierStop, index: number): string {
  const window = escapeHtml(stop.deliveryWindowFrom ?? stop.deliveryWindowTo ?? '—')
  const lines = [
    `${index}. ${window} · <b>${escapeHtml(stop.locationName)}</b> (${escapeHtml(stop.clientName)})`,
  ]
  if (stop.locationAddress.trim()) {
    lines.push(`   <code>${escapeHtml(stop.locationAddress)}</code>`)
  }
  if (stop.clientContactPhone?.trim()) {
    lines.push(`   <code>${escapeHtml(stop.clientContactPhone)}</code>`)
  }
  for (const meal of stop.meals) {
    lines.push(`   ${MEAL_TYPE_LABELS[meal.mealType]} — ${formatPortions(meal.portions)}`)
  }
  return lines.join('\n')
}

function splitGroupAtStops(group: CourierAssignmentGroup, maxBodyLength: number): string[] {
  const header = renderGroupHeader(group)
  const continuationHeader = `${header} (продолжение)`
  const fragments: string[] = []
  let current = header

  group.stops.forEach((stop, index) => {
    const renderedStop = renderStop(stop, index + 1)
    const candidate = `${current}\n\n${renderedStop}`
    if (candidate.length <= maxBodyLength) {
      current = candidate
      return
    }

    if (current === header) {
      throw new Error(`Остановка ${stop.locationId} не помещается в Telegram-сообщение`)
    }
    fragments.push(current)
    current = `${continuationHeader}\n\n${renderedStop}`
    if (current.length > maxBodyLength) {
      throw new Error(`Остановка ${stop.locationId} не помещается в Telegram-сообщение`)
    }
  })

  fragments.push(current)
  return fragments
}

/**
 * Детерминированный HTML. Каждая часть повторяет заголовок; разрезы возможны
 * только между courier sections или stops, поэтому HTML-теги не повреждаются.
 */
export function formatCourierAssignmentMessages(
  groups: CourierAssignmentGroup[],
  deliveryDate: Date,
  maxLength = TELEGRAM_MAX_LEN,
): string[] {
  const title = `🚚 Курьеры на завтра — ${formatDateMsk(deliveryDate)}`
  if (groups.length === 0) return [title]

  const maxBodyLength = maxLength - title.length - 2
  if (maxBodyLength <= 0) throw new Error('Лимит Telegram меньше заголовка сводки')

  const blocks = groups.flatMap((group) => splitGroupAtStops(group, maxBodyLength))
  const bodies: string[] = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= maxBodyLength) {
      current = candidate
      continue
    }
    if (current) bodies.push(current)
    current = block
  }
  if (current) bodies.push(current)

  return bodies.map((body) => `${title}\n\n${body}`)
}
