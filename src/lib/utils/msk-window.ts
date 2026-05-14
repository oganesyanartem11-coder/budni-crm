/**
 * МСК-окно доставки. ClientLocation.deliveryWindowFrom/To хранятся как «HH:mm»
 * (МСК-локальное время); deliveryDate хранится в БД как UTC-полночь МСК-даты.
 * Один общий хелпер на server-action, client-component и cron.
 */
const MSK_OFFSET_HOURS = 3

/**
 * Преобразует «HH:mm» (МСК) на конкретный календарный день в UTC-момент.
 * @param hhmm Время в МСК, например "16:30". null → null.
 * @param deliveryDateUtc Date, представляющая UTC-полночь МСК-даты (как лежит в БД).
 * Возвращает Date в UTC, соответствующий HH:mm МСК на тот календарный день.
 */
export function parseWindowToDate(hhmm: string | null, deliveryDateUtc: Date): Date | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const result = new Date(deliveryDateUtc)
  result.setUTCHours(hours - MSK_OFFSET_HOURS, minutes, 0, 0)
  return result
}
