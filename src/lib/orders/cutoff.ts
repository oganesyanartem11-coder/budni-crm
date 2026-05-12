import { fromZonedTime } from 'date-fns-tz'

/**
 * Cut-off — момент, после которого DYNAMIC-заказы на следующий день
 * считаются «принятыми» и любые правки помечаются как пост-cut-off.
 *
 * Auto-lock в 16:00 отменён в Спринте 5.0a — менеджер может править
 * заказы в CRM без ограничений. Бэдж «правлено после cut-off» теперь
 * показывается по времени правки относительно cut-off дня перед доставкой.
 *
 * Cut-off привязан к зоне Europe/Moscow, чтобы корректно работать
 * на Vercel (UTC) — иначе setHours(18) в UTC даст 21:00 МСК.
 */
export const CUTOFF_HOUR_MSK = 16
export const MSK_TIMEZONE = 'Europe/Moscow'

/**
 * Возвращает момент cut-off (CUTOFF_HOUR_MSK по Europe/Moscow) для дня
 * перед deliveryDate, как UTC Date. Использует fromZonedTime, чтобы
 * корректно учитывать летнее/зимнее время.
 */
export function getCutoffMoment(deliveryDate: Date): Date {
  const dayBefore = new Date(deliveryDate)
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)

  const yyyy = dayBefore.getUTCFullYear()
  const mm = String(dayBefore.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dayBefore.getUTCDate()).padStart(2, '0')
  const hh = String(CUTOFF_HOUR_MSK).padStart(2, '0')
  const localStr = `${yyyy}-${mm}-${dd}T${hh}:00:00`

  return fromZonedTime(localStr, MSK_TIMEZONE)
}

/**
 * Проверяет, прошёл ли cut-off для заказа с заданной датой доставки.
 */
export function isPastCutoff(deliveryDate: Date, now: Date = new Date()): boolean {
  return now.getTime() >= getCutoffMoment(deliveryDate).getTime()
}
