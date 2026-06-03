import type { ParseResult } from './parser'

/**
 * MEGA-1 sanity-checks для распарсенной недельной заявки. Чистая функция (без IO,
 * без Date.now) — детерминированно валидирует ParseResult против ожиданий клиента.
 * Используется перед автоматическим созданием WeeklyOrderSubmission, чтобы
 * отсечь явно подозрительный вывод LLM на ручную проверку менеджером.
 */

export interface SanityContext {
  expectedDaysPerWeek: number
  typicalPortionsPerDay: number
  weekStartDate: Date
}

export interface SanityResult {
  ok: boolean
  failures: string[]
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_CONFIDENCE = 0.95

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * YYYY-MM-DD по МСК-календарю для UTC-инстанта. Сдвиг +3ч и чтение UTC-компонент
 * (MSK = UTC+3, без DST), как в src/lib/utils/week.ts.
 */
function toMskDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + MSK_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Валидна ли YYYY-MM-DD строка как реальная календарная дата (regex + Date
 * validity, с проверкой что Date не перенормализовал, например 2026-02-30).
 */
function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  )
}

export function runSanityChecks(parsed: ParseResult, context: SanityContext): SanityResult {
  const failures: string[] = []

  // 1. confidence >= 0.95
  if (parsed.confidence < MIN_CONFIDENCE) {
    failures.push(
      `confidence ${parsed.confidence} ниже порога ${MIN_CONFIDENCE}`
    )
  }

  // 2. items.length в [1, expectedDaysPerWeek + 1]
  const maxDays = context.expectedDaysPerWeek + 1
  if (parsed.items.length < 1) {
    failures.push('items пуст — не извлечено ни одного дня')
  } else if (parsed.items.length > maxDays) {
    failures.push(
      `items содержит ${parsed.items.length} дней — больше ожидаемого максимума ${maxDays}`
    )
  }

  // 3. Каждый portions в [typical*0.5, typical*2.0] включительно
  const minPortions = context.typicalPortionsPerDay * 0.5
  const maxPortions = context.typicalPortionsPerDay * 2.0
  for (const item of parsed.items) {
    if (item.portions < minPortions || item.portions > maxPortions) {
      failures.push(
        `порции ${item.portions} (${item.date}) вне диапазона [${minPortions}, ${maxPortions}]`
      )
    }
  }

  // 4. Каждая дата — валидная YYYY-MM-DD
  for (const item of parsed.items) {
    if (!isValidDateString(item.date)) {
      failures.push(`невалидная дата "${item.date}"`)
    }
  }

  // 5. Каждая дата в [weekStartDate, weekStartDate+6 дней] по МСК-календарю.
  //    Сравнение по строке календарной даты — без TZ-дрейфа.
  const mondayStr = toMskDateString(context.weekStartDate)
  const sundayStr = toMskDateString(new Date(context.weekStartDate.getTime() + 6 * DAY_MS))
  for (const item of parsed.items) {
    // Пропускаем заведомо невалидные — про них уже сказало правило 4.
    if (!isValidDateString(item.date)) continue
    if (item.date < mondayStr || item.date > sundayStr) {
      failures.push(
        `дата ${item.date} вне недели ${mondayStr}—${sundayStr}`
      )
    }
  }

  // 6. Нет дубликатов дат
  const seen = new Set<string>()
  const reported = new Set<string>()
  for (const item of parsed.items) {
    if (seen.has(item.date) && !reported.has(item.date)) {
      failures.push(`дубликат даты ${item.date}`)
      reported.add(item.date)
    }
    seen.add(item.date)
  }

  return { ok: failures.length === 0, failures }
}
