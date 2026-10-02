import type { MealType } from '@prisma/client'
import type { ParseResult } from './parser'
import { WINDOW_DAYS } from './parser'
import {
  isDeliveryDateEditable,
  type LocationForEditability,
} from '@/lib/orders/client-portions'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

/**
 * Построчный разбор недельной заявки (чистая функция, now инъектируется).
 *
 * Было (до 01.10.2026): гейт «всё или ничего» — confidence ≥ 0.95, даты строго
 * в следующей неделе, порции в коридоре 50–200% от типичных. Любой провал →
 * ручная проверка без кнопок, ни одного заказа.
 *
 * Стало: каждая строка — ok / skip / blocked.
 *  - skip — дата прошла, дальше 14 дней или приём закрыт по cut-off точки:
 *    строку пропускаем с пометкой, остальные применяются;
 *  - blocked — не понятно, что вносить (невалидная дата/число, неясная точка,
 *    дубль, у питания нет цены): автоприменение невозможно, нужен менеджер.
 * Автоприменение — confidence ≥ 0.8, нет blocked и есть хоть одна ok-строка.
 */

export const AUTO_APPLY_MIN_CONFIDENCE = 0.8

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

export interface WeeklyConfigOption {
  configId: string
  locationId: string
  locationName: string
  mealType: MealType
  pricePerPortion: number
  location: LocationForEditability
}

export type WeeklyLineStatus = 'ok' | 'skip' | 'blocked'

export interface WeeklyLine {
  date: string
  /** UTC-полночь МСК-дня (@db.Date); null — дата невалидна. */
  deliveryDate: Date | null
  portions: number
  status: WeeklyLineStatus
  note: string | null
  config: WeeklyConfigOption | null
}

export interface WeeklyClassification {
  lines: WeeklyLine[]
  /** Причины, почему не автомат (пусто → можно применять автоматически). */
  reviewReasons: string[]
  autoApply: boolean
}

/** `YYYY-MM-DD` → UTC-полночь той же календарной даты, null если невалидна. */
export function parseItemDate(dateStr: string): Date | null {
  const m = DATE_RE.exec(dateStr)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

export function classifyWeeklyItems(
  parsed: ParseResult,
  configs: WeeklyConfigOption[],
  now: Date = new Date(),
): WeeklyClassification {
  const today = getMskCalendarDayUtc(now, 0)
  const lastDay = new Date(today.getTime() + WINDOW_DAYS * DAY_MS)
  const reviewReasons: string[] = []

  if (parsed.confidence < AUTO_APPLY_MIN_CONFIDENCE) {
    reviewReasons.push(
      `уверенность распознавания ${parsed.confidence.toFixed(2)} ниже ${AUTO_APPLY_MIN_CONFIDENCE}` +
        (parsed.reason ? ` (${parsed.reason})` : ''),
    )
  }
  if (configs.length === 0) reviewReasons.push('у клиента нет активного недельного питания')

  const seen = new Set<string>()
  const lines: WeeklyLine[] = parsed.items.map((item) => {
    const deliveryDate = parseItemDate(item.date)
    const base = { date: item.date, deliveryDate, portions: item.portions }

    if (!deliveryDate) return { ...base, status: 'blocked', note: `непонятная дата «${item.date}»`, config: null }
    if (!Number.isInteger(item.portions) || item.portions < 0) {
      return { ...base, status: 'blocked', note: `непонятное количество «${item.portions}»`, config: null }
    }

    const candidates = item.locationId
      ? configs.filter((c) => c.locationId === item.locationId)
      : configs
    if (candidates.length !== 1) {
      return {
        ...base,
        status: 'blocked',
        note:
          candidates.length === 0
            ? 'не нашёл точку'
            : new Set(candidates.map((c) => c.locationId)).size === 1
              ? 'непонятно, на какой приём пищи'
              : 'непонятно, на какую точку',
        config: null,
      }
    }
    const config = candidates[0]

    const key = `${config.configId}:${item.date}`
    if (seen.has(key)) return { ...base, status: 'blocked', note: 'дата повторяется', config }
    seen.add(key)

    if (!(config.pricePerPortion > 0)) {
      return { ...base, status: 'blocked', note: 'у питания не задана цена', config }
    }
    if (deliveryDate.getTime() < today.getTime()) {
      return { ...base, status: 'skip', note: 'дата уже прошла', config }
    }
    if (deliveryDate.getTime() > lastDay.getTime()) {
      return { ...base, status: 'skip', note: `дальше ${WINDOW_DAYS} дней`, config }
    }
    if (!isDeliveryDateEditable(config.location, deliveryDate, now)) {
      return { ...base, status: 'skip', note: 'приём на эту дату уже закрыт', config }
    }
    return { ...base, status: 'ok', note: null, config }
  })

  if (lines.length === 0) reviewReasons.push('не распознано ни одной строки')
  const blocked = lines.filter((l) => l.status === 'blocked')
  if (blocked.length > 0) {
    reviewReasons.push(`неоднозначные строки: ${blocked.map((l) => `${l.date} — ${l.note}`).join('; ')}`)
  }
  if (lines.length > 0 && !lines.some((l) => l.status === 'ok') && blocked.length === 0) {
    reviewReasons.push('нет дат, которые ещё можно внести')
  }

  return { lines, reviewReasons, autoApply: reviewReasons.length === 0 }
}

/** Понедельник (UTC-полночь МСК-дня) недели, в которую попадает @db.Date-день. */
export function mondayOf(day: Date): Date {
  const daysToMon = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - daysToMon * DAY_MS)
}

const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const

/** `YYYY-MM-DD` → «пн 5 окт» (день недели по самой календарной дате, без tz сервера). */
export function formatWeeklyDate(dateStr: string): string {
  const d = parseItemDate(dateStr)
  if (!d) return dateStr
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`
}
