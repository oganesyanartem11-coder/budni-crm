import { prisma } from '@/lib/db/prisma'
import { buildLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'
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
 * 7.39: определяет фактическую дату доставки для конфига.
 *
 * - Если локация конфига работает в режиме same-day (`location.sameDayDelivery === true`),
 *   заказ генерируется на СЕГОДНЯ по МСК (`getMskCalendarDayUtc(now, 0)`).
 * - Иначе — на переданную `defaultDate` (обычно завтра по МСК, как было раньше).
 *
 * Чистая функция (без БД) — тестируется отдельно. `today` передаётся явно,
 * чтобы вычислить «сегодня МСК» один раз вне цикла и не дёргать Intl на каждый конфиг.
 */
export function resolveTargetDate(
  config: { location: { sameDayDelivery: boolean } },
  defaultDate: Date,
  today: Date,
): Date {
  return config.location.sameDayDelivery ? today : defaultDate
}

/** Начало (00:00:00.000) и конец (23:59:59.999) суток, в которые попадает `date`. */
function dayWindow(date: Date): { start: Date; end: Date } {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/**
 * Генерирует FIXED-заказы на указанную дату для всех активных FIXED-конфигов.
 * Идемпотентно: повторный запуск не создаёт дублей (проверка по sourceConfigId + deliveryDate).
 */
export async function generateFixedOrdersForDate(targetDate: Date, options: {
  triggeredByUserId?: string | null
}): Promise<GenerationStats> {
  // Нормализуем «дефолтную» дату (обычно завтра МСК) на начало дня.
  const date = new Date(targetDate)
  date.setHours(0, 0, 0, 0)

  // 7.39: same-day локации генерируются на СЕГОДНЯ МСК. Вычисляем один раз.
  const todayMsk = getMskCalendarDayUtc(new Date(), 0)

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
      location: {
        select: {
          id: true,
          isActive: true,
          packaging: true,
          // 7.39: same-day delivery — конфиги такой локации генерируются на СЕГОДНЯ (МСК),
          // а не на завтра. cutoff* грузим на будущее (фильтрация по cutoff — отдельная зона).
          sameDayDelivery: true,
          cutoffHourMsk: true,
          cutoffMinuteMsk: true,
        },
      },
    },
  })

  stats.candidatesTotal = configs.length

  // 7.39: конфиги могут адресоваться на ДВЕ разные даты в одном запуске —
  // дефолтную (завтра) для обычных локаций и СЕГОДНЯ для same-day. Поэтому
  // существующие заказы грузим по объединённому диапазону, а дедуп-ключ
  // включает саму дату доставки (иначе same-day заказ ошибочно «слипся» бы
  // с обычным заказом того же клиента/локации/mealType на другую дату).
  const defaultWindow = dayWindow(date)
  const todayWindow = dayWindow(todayMsk)
  const rangeStart = defaultWindow.start < todayWindow.start ? defaultWindow.start : todayWindow.start
  const rangeEnd = defaultWindow.end > todayWindow.end ? defaultWindow.end : todayWindow.end

  const existingOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: rangeStart, lte: rangeEnd },
      status: { not: 'CANCELLED' },
    },
    select: {
      clientId: true,
      locationId: true,
      mealType: true,
      deliveryDate: true,
    },
  })
  // Ключ дедупа: clientId|locationId|mealType|YYYY-MM-DD (дата доставки).
  const dedupKey = (clientId: string, locationId: string, mealType: string, d: Date) =>
    `${clientId}|${locationId}|${mealType}|${dayWindow(d).start.toISOString()}`
  const existingKeys = new Set(
    existingOrders.map((o) => dedupKey(o.clientId, o.locationId, o.mealType, o.deliveryDate))
  )

  // Обрабатываем каждый конфиг
  for (const config of configs) {
    // 7.39: дата per-config — same-day локация → сегодня МСК, иначе → дефолт (завтра).
    const configDate = resolveTargetDate(config, date, todayMsk)

    if (!isScheduledForDate(config, configDate)) {
      stats.skippedNoSchedule++
      continue
    }

    stats.matchedSchedule++

    // Конфиг всегда привязан к конкретной точке (locationId NOT NULL).
    const targetLocations: Array<{ id: string; packaging: 'INDIVIDUAL' | 'BULK' }> = [
      { id: config.location.id, packaging: config.location.packaging },
    ]

    // Фильтруем точки: оставляем только те для которых ещё нет заказа на ЭТУ (per-config)
    // дату с этим mealType. Ключ включает configDate — см. dedupKey выше.
    const newLocations = targetLocations.filter((loc) => {
      const key = dedupKey(config.clientId, loc.id, config.mealType, configDate)
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
        deliveryDate: configDate,
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

      await prisma.order.createMany({ data: ordersData, skipDuplicates: true })
      stats.created += ordersData.length
      if (isFixed) {
        stats.createdFixed += ordersData.length
      } else {
        stats.createdDynamic += ordersData.length
      }
      // Регистрируем что мы только что создали — на случай если ещё один конфиг попал бы в ту же ячейку
      for (const loc of newLocations) {
        existingKeys.add(dedupKey(config.clientId, loc.id, config.mealType, configDate))
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
