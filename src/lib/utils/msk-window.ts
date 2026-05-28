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
