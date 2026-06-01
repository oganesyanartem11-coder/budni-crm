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
export function getCutoffMoment(
  deliveryDate: Date,
  hour: number = CUTOFF_HOUR_MSK,
  minute: number = 0
): Date {
  const dayBefore = new Date(deliveryDate)
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)

  const yyyy = dayBefore.getUTCFullYear()
  const mm = String(dayBefore.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dayBefore.getUTCDate()).padStart(2, '0')
  const hh = String(hour).padStart(2, '0')
  const mi = String(minute).padStart(2, '0')
  const localStr = `${yyyy}-${mm}-${dd}T${hh}:${mi}:00`

  return fromZonedTime(localStr, MSK_TIMEZONE)
}

/**
 * Проверяет, прошёл ли cut-off для заказа с заданной датой доставки.
 */
export function isPastCutoff(deliveryDate: Date, now: Date = new Date()): boolean {
  return now.getTime() >= getCutoffMoment(deliveryDate).getTime()
}

/**
 * Момент cut-off (CUTOFF_HOUR_MSK по Europe/Moscow) СЕГОДНЯШНЕГО дня по МСК,
 * как UTC Date. «Сегодня» определяется по календарной дате в зоне МСК (а не
 * по локальному времени сервера — на Vercel это UTC, и после 21:00 МСК UTC-дата
 * уже «завтра»). Поэтому день берём из now, отформатированного в МСК.
 */
export function getTodayCutoffMomentMsk(
  now: Date,
  hour: number = CUTOFF_HOUR_MSK,
  minute: number = 0
): Date {
  // ru-RU + явный TZ даёт стабильный 'dd.mm.yyyy' в зоне МСК.
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const yyyy = get('year')
  const mm = get('month')
  const dd = get('day')
  const hh = String(hour).padStart(2, '0')
  const mi = String(minute).padStart(2, '0')
  // fromZonedTime трактует строку как локальное МСК-время → корректный UTC.
  return fromZonedTime(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00`, MSK_TIMEZONE)
}

export interface CutoffCountdown {
  hoursLeft: number
  minutesLeft: number
  totalMinutesLeft: number
  isPast: boolean
  isToday: boolean
}

/**
 * Сколько осталось до cut-off (16:00 МСК). Чистая функция (без I/O).
 *
 * - deliveryDate задан → cut-off = день ПЕРЕД доставкой в 16:00 МСК (getCutoffMoment).
 * - deliveryDate не задан/null → cut-off = СЕГОДНЯ 16:00 МСК (по календарю МСК).
 *
 * totalMinutesLeft — округлённые минуты от now до cut-off (может быть < 0).
 * hoursLeft/minutesLeft клампятся к 0. isPast = cut-off уже наступил/прошёл.
 * isToday — момент cut-off попадает в сегодняшние сутки по МСК (всегда true,
 * когда deliveryDate не задан, т.к. там cut-off строится именно на сегодня).
 */
export function getCutoffCountdown(
  deliveryDate?: Date | null,
  now: Date = new Date()
): CutoffCountdown {
  const cutoffMoment = deliveryDate
    ? getCutoffMoment(deliveryDate)
    : getTodayCutoffMomentMsk(now)

  const diffMs = cutoffMoment.getTime() - now.getTime()
  const totalMinutesLeft = Math.round(diffMs / 60_000)
  const clamped = Math.max(0, totalMinutesLeft)
  const hoursLeft = Math.floor(clamped / 60)
  const minutesLeft = clamped % 60
  const isPast = totalMinutesLeft <= 0

  // isToday: совпадает ли календарная дата cut-off-момента с «сегодня» по МСК.
  // Сравниваем dd.mm.yyyy в зоне МСК, чтобы не зависеть от TZ сервера.
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: MSK_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  const isToday = fmt(cutoffMoment) === fmt(now)

  return { hoursLeft, minutesLeft, totalMinutesLeft, isPast, isToday }
}
