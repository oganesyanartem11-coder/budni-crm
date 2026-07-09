/**
 * Производственный календарь РФ (М3): рабочие/нерабочие дни для окон решалки.
 *
 * B2B-доставка обедов живёт по будням: 14 календарных дней окна = 10 рабочих, и
 * сравнения «день к дню» через выходные/праздники врут. Все окна пофразной
 * экономики/минусовки/исходов/уроков считаются в РАБОЧИХ днях по этому календарю.
 *
 * Список праздников СТАТИЧЕСКИЙ (2026). Для дат вне известного года — фолбэк на
 * выходные + разовый warn (лучше грубее, чем упасть). Карантинный гейт (возраст
 * кампании) календарь НЕ трогает — там другой смысл (астрономический возраст).
 */

import { isWeekend } from './diagnostics'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Нерабочие праздничные дни РФ 2026 (производственный календарь; перенесённые
 * выходные учтены): новогодние 01–08.01; 23.02; 09.03 (перенос с вс 08.03);
 * 01.05; 11.05 (перенос с сб 09.05); 12.06; 04.11.
 */
export const RU_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
  '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08',
  '2026-02-23',
  '2026-03-09',
  '2026-05-01', '2026-05-11',
  '2026-06-12',
  '2026-11-04',
])

const KNOWN_YEARS = new Set(['2026'])
const warnedYears = new Set<string>()

/** UTC-момент начала МСК-дня 'YYYY-MM-DD' (совпадает с brain.mskDayStartUtc). */
function dayStartUtc(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`)
}

/** МСК-день UTC-момента (совпадает с brain.mskDay). */
function mskDayOf(date: Date): string {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * Рабочий ли день (МСК 'YYYY-MM-DD'): не выходной И не праздник РФ. Для дат вне
 * известного календаря (год ≠ 2026) — фолбэк !isWeekend + разовый warn на год.
 */
export function isWorkday(day: string): boolean {
  const year = day.slice(0, 4)
  if (!KNOWN_YEARS.has(year)) {
    if (!warnedYears.has(year)) {
      console.warn(
        `[boris-direct/workdays] нет статического календаря праздников РФ для ${year} — фолбэк на выходные`
      )
      warnedYears.add(year)
    }
    return !isWeekend(day)
  }
  return !isWeekend(day) && !RU_HOLIDAYS_2026.has(day)
}

/**
 * UTC-начало МСК-дня, который является nWorkdays-м РАБОЧИМ днём НАЗАД от endDay
 * включительно (сам endDay считается, если рабочий). nWorkdays≥1. Окно
 * [результат … endDay] содержит ровно nWorkdays рабочих дней (плюс выходные/
 * праздники между ними, где данных нет). Для findMany-выборки снапшотов.
 */
export function workdayWindowStartUtc(endDay: string, nWorkdays: number): Date {
  const n = Math.max(1, Math.floor(nWorkdays))
  let d = dayStartUtc(endDay)
  let count = isWorkday(endDay) ? 1 : 0
  while (count < n) {
    d = new Date(d.getTime() - DAY_MS)
    if (isWorkday(mskDayOf(d))) count++
  }
  return d
}

/**
 * UTC-начало МСК-дня, который является nWorkdays-м РАБОЧИМ днём ВПЕРЁД от startDay
 * включительно (сам startDay считается, если рабочий). Для окна «после» в исходах.
 */
export function addWorkdaysUtc(startDay: string, nWorkdays: number): Date {
  const n = Math.max(1, Math.floor(nWorkdays))
  let d = dayStartUtc(startDay)
  let count = isWorkday(startDay) ? 1 : 0
  while (count < n) {
    d = new Date(d.getTime() + DAY_MS)
    if (isWorkday(mskDayOf(d))) count++
  }
  return d
}
