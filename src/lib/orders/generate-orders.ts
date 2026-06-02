import { prisma } from '@/lib/db/prisma'
import { buildLegalEntitySnapshot } from '@/lib/orders/legal-entity-snapshot'
import { getMskCalendarDayUtc, toMskDateString } from '@/lib/utils/msk-window'
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
  // 7.41: заполняются только generateFixedOrdersForRange. Для single-day
  // generateFixedOrdersForDate остаются undefined (обратная совместимость).
  rangeStart?: string
  rangeEnd?: string
  days?: number
  sameDayProcessed?: number
  rangeProcessed?: number
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

/**
 * 7.41: чистое планирование дат доставки для одного конфига на горизонт `days`.
 *
 * - same-day локация → ровно [сегодня МСК] (offset 0), если расписание попадает.
 *   Решение продукта: same-day горизонт остаётся 1 день, в диапазон НЕ входит.
 * - обычная локация → дни диапазона offset 1..days (завтра..сегодня+days),
 *   отфильтрованные по isScheduledForDate (WEEKDAYS пропустит сб/вс и т.п.).
 *
 * Без БД и без дедупа — только «какие даты по расписанию». Дедуп по уже
 * существующим заказам делает вызывающий generateFixedOrdersForRange.
 * `sameDayDelivery` передаётся отдельно, чтобы функцию можно было тестировать
 * с минимальным объектом конфига (как resolveTargetDate).
 */
export function planConfigDeliveryDates(
  config: ClientMealConfig,
  sameDayDelivery: boolean,
  now: Date,
  days: number,
): Date[] {
  if (sameDayDelivery) {
    const today = getMskCalendarDayUtc(now, 0)
    return isScheduledForDate(config, today) ? [today] : []
  }
  const dates: Date[] = []
  for (let offset = 1; offset <= days; offset++) {
    const date = getMskCalendarDayUtc(now, offset)
    if (isScheduledForDate(config, date)) dates.push(date)
  }
  return dates
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

/**
 * 7.41: пролонгация FIXED/DYNAMIC-заказов на горизонт `days` дней вперёд.
 *
 * Зачем: видеть планирование заранее + защита от пропусков Vercel cron —
 * ежедневный запуск перекрывает [сегодня..сегодня+days] и идемпотентно
 * «дозаполняет» дни, которые мог пропустить упавший cron (date-aware
 * партиальный unique `order_business_key` + skipDuplicates + in-memory Set).
 *
 * Раздельный обход (см. planConfigDeliveryDates):
 *  - same-day локации обрабатываются ровно на СЕГОДНЯ (offset 0), в диапазон
 *    1..days не входят (горизонт same-day остаётся 1 день — решение продукта);
 *  - обычные локации — на каждый день диапазона offset 1..days, прошедший
 *    проверку расписания.
 *
 * `startDate` используется для лейблинга (обычно = завтра МСК); сами даты
 * вычисляются от текущего МСК-дня через getMskCalendarDayUtc(now, offset),
 * поэтому функция не подходит для «генерации на произвольную дату» — для
 * этого остаётся generateFixedOrdersForDate (manual-trigger).
 */
export async function generateFixedOrdersForRange(
  startDate: Date,
  days: number,
  options: { triggeredByUserId?: string | null }
): Promise<GenerationStats> {
  const now = new Date()
  const todayMsk = getMskCalendarDayUtc(now, 0)
  // Объединённый диапазон существующих заказов: от сегодня (same-day, offset 0)
  // до последнего дня горизонта (offset days). deliveryDate — @db.Date (UTC-
  // полночь календарной даты), поэтому inclusive lte по UTC-полночи корректен.
  const rangeStartDate = todayMsk
  const rangeEndDate = getMskCalendarDayUtc(now, days)

  const stats: GenerationStats = {
    targetDate: startDate.toISOString(),
    candidatesTotal: 0,
    matchedSchedule: 0,
    created: 0,
    createdFixed: 0,
    createdDynamic: 0,
    skippedExisting: 0,
    skippedNoSchedule: 0,
    errors: [],
    rangeStart: toMskDateString(rangeStartDate),
    rangeEnd: toMskDateString(rangeEndDate),
    days,
    sameDayProcessed: 0,
    rangeProcessed: 0,
  }

  // Грузим все активные FIXED+DYNAMIC конфиги ОДИН раз (тот же include, что и
  // generateFixedOrdersForDate — нужны client-снапшот юрлица и поля локации).
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
          sameDayDelivery: true,
          cutoffHourMsk: true,
          cutoffMinuteMsk: true,
        },
      },
    },
  })

  stats.candidatesTotal = configs.length

  // Существующие (не отменённые) заказы по всему диапазону — для антидубля.
  // Ключ включает дату доставки: clientId|locationId|mealType|YYYY-MM-DD (МСК).
  const existingOrders = await prisma.order.findMany({
    where: {
      deliveryDate: { gte: rangeStartDate, lte: rangeEndDate },
      status: { not: 'CANCELLED' },
    },
    select: {
      clientId: true,
      locationId: true,
      mealType: true,
      deliveryDate: true,
    },
  })
  const dedupKey = (clientId: string, locationId: string, mealType: string, d: Date) =>
    `${clientId}|${locationId}|${mealType}|${toMskDateString(d)}`
  const existingKeys = new Set(
    existingOrders.map((o) => dedupKey(o.clientId, o.locationId, o.mealType, o.deliveryDate))
  )

  // Накапливаем все заказы и пишем одним createMany в конце.
  type OrderInsert = {
    clientId: string
    locationId: string
    mealType: ClientMealConfig['mealType']
    deliveryDate: Date
    portions: number
    pricePerPortion: number
    totalPrice: number
    packaging: 'INDIVIDUAL' | 'BULK'
    source: 'FIXED_AUTO' | 'RECURRING_AUTO'
    status: 'CONFIRMED' | 'PENDING_CONFIRMATION'
    sourceConfigId: string
    confirmedAt: Date | null
    ourLegalEntityId: string | null
    vatRate: ReturnType<typeof buildLegalEntitySnapshot>['vatRate']
  }
  const ordersData: OrderInsert[] = []

  for (const config of configs) {
    // Даты по расписанию для этого конфига (same-day → [сегодня], иначе 1..days).
    const targetDates = planConfigDeliveryDates(config, config.location.sameDayDelivery, now, days)
    if (targetDates.length === 0) {
      stats.skippedNoSchedule++
      continue
    }
    stats.matchedSchedule++

    try {
      const isFixed = config.orderType === 'FIXED'
      const portionsValue = isFixed ? (config.fixedPortions ?? 0) : 0
      const priceNum = Number(config.pricePerPortion)
      const snapshot = buildLegalEntitySnapshot(config.client)

      for (const configDate of targetDates) {
        const key = dedupKey(config.clientId, config.location.id, config.mealType, configDate)
        if (existingKeys.has(key)) {
          stats.skippedExisting++
          continue
        }
        existingKeys.add(key)

        ordersData.push({
          clientId: config.clientId,
          locationId: config.location.id,
          mealType: config.mealType,
          deliveryDate: configDate,
          portions: portionsValue,
          pricePerPortion: priceNum,
          totalPrice: priceNum * portionsValue,
          packaging: config.location.packaging,
          source: isFixed ? 'FIXED_AUTO' : 'RECURRING_AUTO',
          status: isFixed ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
          sourceConfigId: config.id,
          confirmedAt: isFixed ? new Date() : null,
          ourLegalEntityId: snapshot.ourLegalEntityId,
          vatRate: snapshot.vatRate,
        })

        if (config.location.sameDayDelivery) {
          stats.sameDayProcessed!++
        } else {
          stats.rangeProcessed!++
        }
      }
    } catch (err) {
      stats.errors.push({
        configId: config.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (ordersData.length > 0) {
    await prisma.order.createMany({ data: ordersData, skipDuplicates: true })
    stats.created = ordersData.length
    stats.createdFixed = ordersData.filter((o) => o.source === 'FIXED_AUTO').length
    stats.createdDynamic = ordersData.filter((o) => o.source === 'RECURRING_AUTO').length
  }

  // Один агрегированный лог на весь диапазон (entityId = диапазон дат).
  await prisma.activityLog.create({
    data: {
      userId: options.triggeredByUserId ?? null,
      userRole: options.triggeredByUserId ? 'MANAGER' : 'ADMIN',
      action: 'FIXED_ORDERS_GENERATED',
      entityType: 'OrderBatch',
      entityId: `${stats.rangeStart}_to_${stats.rangeEnd}`,
      payload: {
        startDate: stats.targetDate,
        days,
        rangeStart: stats.rangeStart,
        rangeEnd: stats.rangeEnd,
        candidatesTotal: stats.candidatesTotal,
        matchedSchedule: stats.matchedSchedule,
        created: stats.created,
        createdFixed: stats.createdFixed,
        createdDynamic: stats.createdDynamic,
        skippedExisting: stats.skippedExisting,
        skippedNoSchedule: stats.skippedNoSchedule,
        sameDayProcessed: stats.sameDayProcessed,
        rangeProcessed: stats.rangeProcessed,
        errors: stats.errors.length,
      },
    },
  }).catch(() => { /* лог не должен ронять генерацию */ })

  return stats
}
