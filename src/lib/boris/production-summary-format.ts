import { formatOrders, formatPortions, formatMoney } from '@/lib/utils/format'
import { escapeHtml } from '@/lib/telegram/notify'

/**
 * Форматтер сводки производства на 16:00 («Заказы на завтра»).
 *
 * Зона MEGA-3 / SUBAGENT 1. Используется только cron'ом production-summary.
 * Чистая функция без побочных эффектов — удобно тестировать.
 */

export interface ProductionSummaryOrderRow {
  /** Название клиента. */
  clientName: string
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
  /** Выручка по всем заказам, ₽. */
  totalRevenue: number
  /** DYNAMIC-конфиги без ответа (опционально показываем отдельным блоком). */
  unconfirmed?: ProductionSummaryUnconfirmedRow[]
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
 * Одна строка клиента в сводке: «{Клиент}, {Локация} — N порций».
 * Без юр.лица (ООО/ИП/legalName) — только имя клиента и название точки.
 */
export function formatProductionSummaryRow(row: ProductionSummaryOrderRow): string {
  return `${escapeHtml(row.clientName)}, ${escapeHtml(row.locationName)} — ${formatPortions(row.portions)}`
}

/**
 * Полный текст сводки 16:00 (HTML для Telegram).
 */
export function formatProductionSummary(input: ProductionSummaryInput): string {
  const { dateLabel, orders, totalPortions, totalRevenue, unconfirmed = [] } = input

  const sorted = sortProductionSummaryRows(orders)

  const lines: string[] = []

  // Шапка: один эмодзи + итог.
  lines.push(`📋 Заказы на завтра, <i>${escapeHtml(dateLabel)}</i>`)
  lines.push('')
  lines.push(
    `Завтра: ${formatOrders(orders.length)}, ${formatPortions(totalPortions)}, ${formatMoney(totalRevenue)}`
  )

  // Единый список заказов (DYNAMIC + FIXED), без разделения на блоки.
  if (sorted.length > 0) {
    lines.push('')
    for (const row of sorted) {
      lines.push(formatProductionSummaryRow(row))
    }
  }

  // «Не ответили» — оставляем отдельным предупреждающим блоком.
  if (unconfirmed.length > 0) {
    const sortedUnconfirmed = sortProductionSummaryRows(unconfirmed)
    lines.push('')
    lines.push(`⚠️ Не ответили (${sortedUnconfirmed.length}):`)
    for (const c of sortedUnconfirmed) {
      lines.push(`${escapeHtml(c.clientName)}, ${escapeHtml(c.locationName)}`)
    }
  }

  return lines.join('\n')
}
