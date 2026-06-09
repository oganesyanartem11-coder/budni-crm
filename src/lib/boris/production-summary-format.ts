import { formatOrders, formatPortions, formatMoney } from '@/lib/utils/format'
import { escapeHtml } from '@/lib/telegram/notify'

/**
 * Форматтер сводки производства на 16:00 («Заказы на завтра»).
 *
 * Зона MEGA-3 / SUBAGENT 1. Используется только cron'ом production-summary.
 * Чистая функция без побочных эффектов — удобно тестировать.
 */

export interface ProductionSummaryOrderRow {
  /** ID клиента (юр.лица). Ключ группировки one-vs-many локаций. */
  clientId: string
  /** Название клиента (юр.лицо). */
  clientName: string
  /** ID точки/локации — ключ дедупа (две точки с одинаковым именем не схлопываются). */
  locationId: string
  /** Название точки/локации. */
  locationName: string
  /** Суммарное число порций по строке. */
  portions: number
}

export interface ProductionSummaryUnconfirmedRow {
  clientName: string
  locationName: string
}

export interface ProductionSummaryInput {
  /** Человекочитаемая дата завтрашнего дня (напр. «чт, 5 июня»). */
  dateLabel: string
  /**
   * Единый список заказов на завтра: подтверждённые DYNAMIC + фиксированные FIXED,
   * уже сгруппированные по клиент+локация.
   */
  orders: ProductionSummaryOrderRow[]
  /** Сумма порций по всем заказам. */
  totalPortions: number
  /** Выручка по ЕДЕ по всем заказам, ₽. Формула не менялась. */
  totalRevenue: number
  /**
   * Волна 4: сервисная выручка (доставка) за день, ₽. Опционально — если > 0,
   * к итоговой строке добавляется «+ X ₽ доставка». Маржа на это НЕ опирается.
   */
  deliveryRevenue?: number
  /** DYNAMIC-конфиги без ответа (опционально показываем отдельным блоком). */
  unconfirmed?: ProductionSummaryUnconfirmedRow[]
}

/**
 * П3-механизм1: статусы Order, при которых DYNAMIC-конфиг считается «отвеченным».
 *
 * Бизнес-ключ матчинга — (clientId, locationId, mealType), НЕ sourceConfigId:
 * ручной заказ (source MANUAL) может иметь sourceConfigId=null, и тогда матчинг
 * по конфигу ложно относил бы динамику в «Не ответили».
 *
 * «Отвечено» = существует Order на завтра с тем же бизнес-ключом и статусом
 * НЕ в [DRAFT, CANCELLED, PENDING_CONFIRMATION], т.е. фактически
 * CONFIRMED / LOCKED / IN_PRODUCTION / OUT_FOR_DELIVERY / DELIVERED.
 */
const ANSWERED_ORDER_STATUSES = new Set([
  'CONFIRMED',
  'LOCKED',
  'IN_PRODUCTION',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
])

/** Минимальная форма конфига для матчинга «Не ответили». */
export interface UnconfirmedConfigInput {
  clientId: string
  locationId: string
  mealType: string
}

/** Минимальная форма заказа для матчинга «Не ответили». */
export interface UnconfirmedOrderInput {
  clientId: string
  locationId: string
  mealType: string
  status: string
}

/**
 * Бизнес-ключ для матчинга конфиг↔заказ: клиент + локация + тип приёма пищи.
 */
function businessKey(x: { clientId: string; locationId: string; mealType: string }): string {
  return `${x.clientId}:${x.locationId}:${x.mealType}`
}

/**
 * Чистая логика «Не ответили» (П3-механизм1).
 *
 * Конфиг считается ОТВЕЧЕННЫМ, если среди заказов есть хотя бы один с тем же
 * бизнес-ключом (clientId, locationId, mealType) и статусом из
 * ANSWERED_ORDER_STATUSES. Все активные на завтра DYNAMIC-конфиги без такого
 * заказа возвращаются как «не ответившие».
 *
 * Вынесено из route.ts ради тестируемости без БД.
 */
export function computeUnconfirmedConfigs<T extends UnconfirmedConfigInput>(
  configs: T[],
  orders: UnconfirmedOrderInput[]
): T[] {
  const answeredKeys = new Set<string>()
  for (const o of orders) {
    if (ANSWERED_ORDER_STATUSES.has(o.status)) {
      answeredKeys.add(businessKey(o))
    }
  }
  return configs.filter((c) => !answeredKeys.has(businessKey(c)))
}

/**
 * Сортировка строк заказа: по локации алфавитно, затем по клиенту.
 */
export function sortProductionSummaryRows<
  T extends { clientName: string; locationName: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const byLocation = a.locationName.localeCompare(b.locationName, 'ru')
    if (byLocation !== 0) return byLocation
    return a.clientName.localeCompare(b.clientName, 'ru')
  })
}

/**
 * Одна строка в сводке. Юр.лицо клиента отображается ВСЕГДА; точка/локация —
 * только когда у этого клиента в сводке больше одной локации (иначе точка
 * избыточна).
 *   • >1 локации: «🏢 {Клиент} · {Локация} — N порций»
 *   • ровно 1 локация: «🏢 {Клиент} — N порций»
 * Решение one-vs-many считается над ВСЕМ набором заказов сводки и передаётся
 * сюда флагом showLocation.
 */
export function formatProductionSummaryRow(
  row: ProductionSummaryOrderRow,
  opts: { showLocation: boolean }
): string {
  const client = escapeHtml(row.clientName)
  const portions = formatPortions(row.portions)
  if (opts.showLocation) {
    return `🏢 ${client} · ${escapeHtml(row.locationName)} — ${portions}`
  }
  return `🏢 ${client} — ${portions}`
}

/**
 * Полный текст сводки 16:00 (HTML для Telegram).
 */
export function formatProductionSummary(input: ProductionSummaryInput): string {
  const { dateLabel, orders, totalPortions, totalRevenue, deliveryRevenue = 0, unconfirmed = [] } = input

  const sorted = sortProductionSummaryRows(orders)

  // Решение «одна vs много локаций» считаем над ВСЕМ набором заказов сводки
  // (а не по строке в отрыве), группируя по clientId. Уникальность точек считаем
  // по locationId (а не по имени) — две разные точки с одинаковым названием не
  // схлопываются в Set. Имя точки показываем только когда у клиента в этой сводке
  // больше одной локации.
  const locationsByClient = new Map<string, Set<string>>()
  for (const o of orders) {
    let set = locationsByClient.get(o.clientId)
    if (!set) {
      set = new Set<string>()
      locationsByClient.set(o.clientId, set)
    }
    set.add(o.locationId)
  }

  const lines: string[] = []

  // Шапка: один эмодзи + итог.
  lines.push(`📋 Заказы на завтра, <i>${escapeHtml(dateLabel)}</i>`)
  lines.push('')
  // Волна 4: сервисную выручку добавляем хвостом «+ X ₽ доставка» только когда > 0.
  const deliveryTail = deliveryRevenue > 0 ? ` + ${formatMoney(deliveryRevenue)} доставка` : ''
  lines.push(
    `Завтра: ${formatOrders(orders.length)}, ${formatPortions(totalPortions)}, ${formatMoney(totalRevenue)}${deliveryTail}`
  )

  // Единый список заказов (DYNAMIC + FIXED), без разделения на блоки.
  if (sorted.length > 0) {
    lines.push('')
    for (const row of sorted) {
      const showLocation = (locationsByClient.get(row.clientId)?.size ?? 1) > 1
      lines.push(formatProductionSummaryRow(row, { showLocation }))
    }
  }

  // «Не ответили» — оставляем отдельным предупреждающим блоком.
  if (unconfirmed.length > 0) {
    const sortedUnconfirmed = sortProductionSummaryRows(unconfirmed)
    lines.push('')
    lines.push(`⚠️ Не ответили (${sortedUnconfirmed.length}):`)
    for (const c of sortedUnconfirmed) {
      lines.push(`⏳ ${escapeHtml(c.locationName)}`)
    }
  }

  return lines.join('\n')
}
