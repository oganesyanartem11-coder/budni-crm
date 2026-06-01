import { fromZonedTime } from 'date-fns-tz'

/**
 * МСК-окно доставки. ClientLocation.deliveryWindowFrom/To хранятся как «HH:mm»
 * (МСК-локальное время); deliveryDate хранится в БД как @db.Date.
 * Общий хелпер на server-action, client-component и cron.
 */
const MSK_TIMEZONE = 'Europe/Moscow'

/**
 * Преобразует «HH:mm» (МСК) на конкретный календарный день в UTC-момент.
 * Календарный день извлекаем как Y/M/D в МСК-зоне относительно переданного
 * deliveryDate (защита от случая когда серверный setHours(0,0,0,0) в МСК-локали
 * даёт UTC-момент предыдущей UTC-даты — без приведения к MSK календарь будет
 * на сутки раньше). DST учитывается date-fns-tz.
 *
 * @param hhmm Время в МСК, например "16:30". null → null.
 * @param deliveryDate Любой Date, представляющий нужный календарный день
 *   (UTC-полночь, MSK-полночь, или произвольный момент в течение этого дня —
 *   главное, чтобы при пересчёте в МСК Y/M/D совпали с целевым).
 */
export function parseWindowToDate(hhmm: string | null, deliveryDate: Date): Date | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return null

  // Извлекаем МСК-календарный Y/M/D из deliveryDate (а не UTC) — корректно для
  // случаев когда Date хранит UTC-полночь UTC-даты ИЛИ UTC-момент MSK-полночи.
  // Прибавление 3 часов к UTC и чтение UTC-компонент эквивалентно "получить
  // календарный день в МСК"; для Москвы DST не действует с 2011, +3 константа.
  const mskMoment = new Date(deliveryDate.getTime() + 3 * 60 * 60 * 1000)
  const yyyy = mskMoment.getUTCFullYear()
  const mm = String(mskMoment.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(mskMoment.getUTCDate()).padStart(2, '0')
  const hh = String(Number(m[1])).padStart(2, '0')
  const min = String(Number(m[2])).padStart(2, '0')
  const localStr = `${yyyy}-${mm}-${dd}T${hh}:${min}:00`

  return fromZonedTime(localStr, MSK_TIMEZONE)
}

export function getMskHoursMinutes(now: Date = new Date()): { hours: number; minutes: number } {
  // МСК = UTC+3, DST не действует с 2011. Прибавляем 3ч и читаем UTC-компоненты.
  const mskMoment = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  return { hours: mskMoment.getUTCHours(), minutes: mskMoment.getUTCMinutes() }
}

export function startOfTodayMsk(now: Date = new Date()): Date {
  // Начало текущего МСК-дня как UTC-момент.
  // Прибавляем 3ч, обнуляем UTC-часы/мин/сек/мс, вычитаем 3ч обратно.
  const mskMoment = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  mskMoment.setUTCHours(0, 0, 0, 0)
  return new Date(mskMoment.getTime() - 3 * 60 * 60 * 1000)
}

/**
 * МСК-полночь (00:00:00.000) начала суток, в которые попадает `date`, как
 * UTC-момент. Обобщение startOfTodayMsk на произвольную дату (та же
 * арифметика: +3ч, обнулить UTC-компоненты, −3ч). DST не действует (MSK=UTC+3).
 */
export function getMskDayStart(date: Date): Date {
  const mskMoment = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  mskMoment.setUTCHours(0, 0, 0, 0)
  return new Date(mskMoment.getTime() - 3 * 60 * 60 * 1000)
}

/**
 * Конец МСК-суток, в которые попадает `date`, как UTC-момент.
 *
 * СЕМАНТИКА: последняя миллисекунда суток — МСК 23:59:59.999 (т.е.
 * getMskDayStart(date) + 24ч − 1мс). Выбрано для согласованности с
 * inclusive-границами в digest/material-cost.ts (там dayEnd = dayStart +
 * ONE_DAY_MS − 1, фильтр `lte: dayEnd`) и endOfDay() в dashboard-stats.ts.
 * Предназначено для запросов вида `deliveryDate: { lte: getMskDayEnd(...) }`.
 *
 * NB: для half-open границ `lt: <след. полночь>` используйте вместо этого
 * getMskDayStart(addDays(date, 1)) — это начало СЛЕДУЮЩИХ суток.
 */
export function getMskDayEnd(date: Date): Date {
  const dayStart = getMskDayStart(date)
  return new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1)
}

/**
 * UTC-полночь МСК-КАЛЕНДАРНОГО дня — для query inputs по @db.Date колонкам
 * (deliveryDate и т.п. хранятся как UTC-полночь календарной даты).
 *
 * Отличие от getMskDayStart: тот возвращает UTC-инстант МСК-полночи
 * (МСК 2 июн 00:00 = 1 июн 21:00 UTC), что НЕ совпадает с @db.Date-значением.
 * Здесь берём Y/M/D в МСК и строим Date.UTC(Y,M,D) = UTC-полночь той же даты
 * (МСК 2 июн → 2 июн 00:00 UTC) — ровно как хранится @db.Date.
 *
 * Bug 7.25: на Vercel (UTC) `new Date()` в окне 00:00–03:00 МСК ещё «вчера»,
 * поэтому «сегодня/завтра» через серверный new Date()+setHours уезжали на день.
 *
 * @param now - опорный момент (по умолчанию текущий)
 * @param offsetDays - сдвиг от МСК-сегодня: 0=сегодня, 1=завтра, -1=вчера
 */
export function getMskCalendarDayUtc(now: Date = new Date(), offsetDays = 0): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = Number(parts.find((p) => p.type === 'year')!.value)
  const month = Number(parts.find((p) => p.type === 'month')!.value)
  const day = Number(parts.find((p) => p.type === 'day')!.value)
  // Date.UTC корректно переносит через границы месяца/года при day + offset.
  return new Date(Date.UTC(year, month - 1, day + offsetDays))
}

/**
 * Преобразует Date в строку формата `YYYY-MM-DD` по МСК-календарному дню.
 * Используется для URL-параметра `?date=...` — серверные страницы ждут именно
 * date-only контракт, конкатенируют с `T00:00:00.000Z` и парсят как UTC-Date.
 *
 * Почему НЕ `date.toISOString().slice(0, 10)`:
 * - toISOString() даёт UTC-компоненты, не МСК. В окне 00:00-03:00 МСК
 *   на UTC-машине Vercel `.slice(0, 10)` вернёт вчерашний день.
 * - Тот же класс баг 7.25, который привёл к этому helper'у.
 *
 * Решение: берём Y/M/D в МСК через Intl.DateTimeFormat (как в
 * getMskCalendarDayUtc) и собираем строку. Независимо от tz сервера.
 *
 * @param date - любой Date (обычно либо new Date(), либо результат
 *   getMskCalendarDayUtc, либо локальная полночь через setHours(0,0,0,0))
 * @returns строка формата 'YYYY-MM-DD' (МСК-календарный день)
 */
export function toMskDateString(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((p) => p.type === 'year')!.value
  const month = parts.find((p) => p.type === 'month')!.value
  const day = parts.find((p) => p.type === 'day')!.value
  return `${year}-${month}-${day}`
}
