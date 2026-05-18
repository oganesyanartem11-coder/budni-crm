import { prisma } from '@/lib/db/prisma'
import { buildLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import type { ClientMealConfig, ScheduleType } from '@prisma/client'

export interface GenerationStats {
  targetDate: string
  candidatesTotal: number
  matchedSchedule: number
  created: number
  createdFixed: number
  createdDynamic: number
  skippedExisting: number
  skippedNoSchedule: number
  errors: Array<{ configId: string; error: string }>
}

/**
 * Проверяет: должен ли конфиг производить заказ на эту дату по своему расписанию?
 *
 * Экспортируется, чтобы DAILY_QUESTION cron (5.7a) использовал ту же логику дней,
 * что и FIXED-генератор — иначе клиент получит вопрос в день, когда заказ ему не нужен.
 */
export function isScheduledForDate(config: ClientMealConfig, date: Date): boolean {
  // Проверка validFrom/validTo
  if (config.validFrom && date < config.validFrom) return false
  if (config.validTo && date > config.validTo) return false

  // Получаем день недели: понедельник = 1 ... воскресенье = 7
  const jsDay = date.getDay() // 0 = вс, 1-6 = пн-сб
  const dayOfWeek = jsDay === 0 ? 7 : jsDay

  switch (config.scheduleType as ScheduleType) {
    case 'DAILY':
      return true

    case 'WEEKDAYS':
      return dayOfWeek >= 1 && dayOfWeek <= 5

    case 'WEEKENDS':
      return dayOfWeek === 6 || dayOfWeek === 7

    case 'CUSTOM_DAYS': {
      const data = config.scheduleData as { daysOfWeek?: number[] } | null
      const days = Array.isArray(data?.daysOfWeek) ? data!.daysOfWeek : []
      return days.includes(dayOfWeek)
    }

    case 'INTERVAL': {
      const data = config.scheduleData as { intervalDays?: number } | null
      const interval = data?.intervalDays
      if (!interval || interval <= 0 || !config.validFrom) return false
      // Сколько дней прошло от validFrom до date
      const startDay = new Date(config.validFrom)
      startDay.setHours(0, 0, 0, 0)
      const targetDay = new Date(date)
      targetDay.setHours(0, 0, 0, 0)
      const diffDays = Math.round((targetDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24))
      if (diffDays < 0) return false
      return diffDays % interval === 0
    }

    case 'ONE_TIME': {
      // ONE_TIME: заказ только в день validFrom
      if (!config.validFrom) return false
      const target = new Date(date)
      target.setHours(0, 0, 0, 0)
      const start = new Date(config.validFrom)
      start.setHours(0, 0, 0, 0)
      return target.getTime() === start.getTime()
    }

    default:
      return false
  }
}

/**
 * Генерирует FIXED-заказы на указанную дату для всех активных FIXED-конфигов.
 * Идемпотентно: повторный запуск не создаёт дублей (проверка по sourceConfigId + deliveryDate).
 */
export async function generateFixedOrdersForDate(targetDate: Date, options: {
  triggeredByUserId?: string | null
}): Promise<GenerationStats> {
  // Нормализуем дату на начало дня
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const stats: GenerationStats = {
    targetDate: date.toISOString(),
    candidatesTotal: 0,
    matchedSchedule: 0,
    created: 0,
    createdFixed: 0,
    createdDynamic: 0,
    skippedExisting: 0,
    skippedNoSchedule: 0,
    errors: [],
  }

  // Загружаем активные FIXED и DYNAMIC конфиги. 6.8a: locationId NOT NULL,
  // поэтому fallback "конфиг на всего клиента → expand по локациям" удалён.
  const configs = await prisma.clientMealConfig.findMany({
    where: {
      isActive: true,
      orderType: { in: ['FIXED', 'DYNAMIC'] },
      client: { isActive: true },
      location: { isActive: true },
    },
    include: {
      client: {
        select: {
          id: true,
          isActive: true,
          defaultOurLegalEntityId: true,
          defaultOurLegalEntity: { select: { vatRate: true } },
        },
      },
      location: { select: { id: true, isActive: true, packaging: true } },
    },
  })

  stats.candidatesTotal = configs.length

  // Уже созданные заказы по этой дате — индексируем по бизнес-ключу
  // (clientId + locationId + mealType), чтобы не дублировать независимо от source.
  const existingOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: date, lte: dayEnd },
      status: { not: 'CANCELLED' },
    },
    select: {
      clientId: true,
      locationId: true,
      mealType: true,
    },
  })
  const existingKeys = new Set(
    existingOrders.map((o) => `${o.clientId}|${o.locationId}|${o.mealType}`)
  )

  // Обрабатываем каждый конфиг
  for (const config of configs) {
    if (!isScheduledForDate(config, date)) {
      stats.skippedNoSchedule++
      continue
    }

    stats.matchedSchedule++

    // Конфиг всегда привязан к конкретной точке (locationId NOT NULL).
    const targetLocations: Array<{ id: string; packaging: 'INDIVIDUAL' | 'BULK' }> = [
      { id: config.location.id, packaging: config.location.packaging },
    ]

    // Фильтруем точки: оставляем только те для которых ещё нет заказа на эту дату с этим mealType
    const newLocations = targetLocations.filter((loc) => {
      const key = `${config.clientId}|${loc.id}|${config.mealType}`
      return !existingKeys.has(key)
    })

    if (newLocations.length === 0) {
      stats.skippedExisting++
      continue
    }

    try {
      const isFixed = config.orderType === 'FIXED'
      const portionsValue = isFixed ? (config.fixedPortions ?? 0) : 0
      const priceNum = Number(config.pricePerPortion)
      const snapshot = buildLegalEntitySnapshot(config.client)

      const ordersData = newLocations.map((loc) => ({
        clientId: config.clientId,
        locationId: loc.id,
        mealType: config.mealType,
        deliveryDate: date,
        portions: portionsValue,
        pricePerPortion: priceNum,
        totalPrice: priceNum * portionsValue,
        packaging: loc.packaging,
        source: isFixed ? ('FIXED_AUTO' as const) : ('RECURRING_AUTO' as const),
        status: isFixed ? ('CONFIRMED' as const) : ('PENDING_CONFIRMATION' as const),
        sourceConfigId: config.id,
        confirmedAt: isFixed ? new Date() : null,
        ourLegalEntityId: snapshot.ourLegalEntityId,
        vatRate: snapshot.vatRate,
      }))

      await prisma.order.createMany({ data: ordersData })
      stats.created += ordersData.length
      if (isFixed) {
        stats.createdFixed += ordersData.length
      } else {
        stats.createdDynamic += ordersData.length
      }
      // Регистрируем что мы только что создали — на случай если ещё один конфиг попал бы в ту же ячейку
      for (const loc of newLocations) {
        existingKeys.add(`${config.clientId}|${loc.id}|${config.mealType}`)
      }
    } catch (err) {
      stats.errors.push({
        configId: config.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Лог запуска
  await prisma.activityLog.create({
    data: {
      userId: options.triggeredByUserId ?? null,
      userRole: options.triggeredByUserId ? 'MANAGER' : 'ADMIN',
      action: 'FIXED_ORDERS_GENERATED',
      entityType: 'OrderBatch',
      entityId: date.toISOString().slice(0, 10),
      payload: {
        targetDate: stats.targetDate,
        candidatesTotal: stats.candidatesTotal,
        matchedSchedule: stats.matchedSchedule,
        created: stats.created,
        createdFixed: stats.createdFixed,
        createdDynamic: stats.createdDynamic,
        skippedExisting: stats.skippedExisting,
        skippedNoSchedule: stats.skippedNoSchedule,
        errors: stats.errors.length,
      },
    },
  }).catch(() => { /* лог не должен ронять генерацию */ })

  return stats
}
