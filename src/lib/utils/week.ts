import { ru } from 'date-fns/locale'
import { formatInTimeZone } from 'date-fns-tz'
import { getMskCalendarDayUtc } from '@/lib/utils/msk-window'

// UTC+3 круглый год — Россия отменила переход на летнее время в 2011-м,
// MSK сейчас фиксированный UTC+3 без DST.
const MSK_OFFSET_HOURS = 3
const MSK_OFFSET_MS = MSK_OFFSET_HOURS * 3600 * 1000
const MSK_TIMEZONE = 'Europe/Moscow'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Возвращает понедельник ISO-недели для заданного момента.
 * Семантика: «MSK 00:00 этого понедельника» как UTC-точка
 * (например 2026-05-17T21:00:00.000Z = Пн 18 мая 00:00 МСК).
 *
 * Работает корректно независимо от TZ серверного процесса и браузера клиента —
 * вычисления ведутся через арифметику UTC-миллисекунд со сдвигом на MSK.
 * Унифицировано с getFinancialWeek и expand-menu.ts: все понедельники
 * в системе хранятся и сравниваются как одна и та же UTC-точка.
 */
export function getMondayOfWeek(date: Date): Date {
  const mskShifted = new Date(date.getTime() + MSK_OFFSET_MS)
  const y = mskShifted.getUTCFullYear()
  const m = mskShifted.getUTCMonth()
  const d = mskShifted.getUTCDate()
  const dow = mskShifted.getUTCDay() // 0=Sun..6=Sat в MSK-календаре
  const daysToMon = (dow + 6) % 7 // Пн→0, Вт→1, …, Вс→6
  const mondayMskMidnightAsUtc = Date.UTC(y, m, d - daysToMon, 0, 0, 0, 0)
  return new Date(mondayMskMidnightAsUtc - MSK_OFFSET_MS)
}

/**
 * Возвращает воскресенье ISO-недели для заданного момента.
 * Семантика: «MSK 23:59:59.999 воскресенья» как UTC-точка
 * (например 2026-05-24T20:59:59.999Z = Вс 24 мая 23:59:59.999 МСК).
 */
export function getSundayOfWeek(date: Date): Date {
  const monday = getMondayOfWeek(date)
  return new Date(monday.getTime() + 7 * DAY_MS - 1)
}

/**
 * Сдвигает MSK-понедельник на N недель. Чистая арифметика UTC-миллисекунд:
 * 7 суток ровно (Москва без DST). На входе ожидается MSK-понедельник
 * (результат getMondayOfWeek); на выходе — MSK-понедельник через N недель.
 */
export function shiftWeek(monday: Date, weeks: number): Date {
  return new Date(monday.getTime() + weeks * 7 * DAY_MS)
}

/**
 * Форматирует диапазон недели для UI в MSK-календаре:
 * «18–24 мая 2026» (в одном месяце),
 * «29 апр – 5 мая 2026» (на границе месяцев),
 * «29 дек – 4 янв 2026» (на границе года).
 *
 * formatInTimeZone из date-fns-tz гарантирует MSK-вывод вне зависимости
 * от TZ процесса.
 */
export function formatWeekRange(monday: Date): string {
  const sunday = getSundayOfWeek(monday)
  const mondayMonth = formatInTimeZone(monday, MSK_TIMEZONE, 'M')
  const sundayMonth = formatInTimeZone(sunday, MSK_TIMEZONE, 'M')
  if (mondayMonth === sundayMonth) {
    const mondayDay = formatInTimeZone(monday, MSK_TIMEZONE, 'd')
    const sundayDayMonthYear = formatInTimeZone(sunday, MSK_TIMEZONE, 'd MMMM yyyy', { locale: ru })
    return `${mondayDay}–${sundayDayMonthYear}`
  }
  const mondayDayMonth = formatInTimeZone(monday, MSK_TIMEZONE, 'd MMM', { locale: ru })
  const sundayDayMonthYear = formatInTimeZone(sunday, MSK_TIMEZONE, 'd MMM yyyy', { locale: ru })
  return `${mondayDayMonth} – ${sundayDayMonthYear}`
}

/**
 * true, если переданный момент попадает в ту же MSK-неделю, что и сейчас.
 * Сравнение через нормализованный понедельник, не через date-fns isSameWeek
 * (которая зависит от локальной TZ процесса).
 */
export function isCurrentWeek(date: Date): boolean {
  return getMondayOfWeek(date).getTime() === getMondayOfWeek(new Date()).getTime()
}

/**
 * Названия дней недели (понедельник = 1).
 */
export const WEEKDAY_NAMES_FULL: Record<number, string> = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
}

export const WEEKDAY_NAMES_SHORT: Record<number, string> = {
  1: 'Пн',
  2: 'Вт',
  3: 'Ср',
  4: 'Чт',
  5: 'Пт',
  6: 'Сб',
  7: 'Вс',
}

/**
 * Возвращает дату для конкретного дня недели (ISO 1=Пн..7=Вс) от MSK-понедельника.
 * Результат — «MSK 00:00 этого дня» как UTC-точка.
 */
export function getDateForDayOfWeek(monday: Date, dayOfWeek: number): Date {
  return new Date(monday.getTime() + (dayOfWeek - 1) * DAY_MS)
}

/**
 * Финансовая неделя «Будни»: Сб 00:00:00.000 МСК → Пт 23:59:59.999 МСК.
 *
 * Работает корректно независимо от TZ серверного процесса:
 * вычисления ведутся явно в MSK через арифметику UTC-миллисекунд.
 *
 * До этого использовался setHours() в локальной TZ процесса. На Vercel
 * runtime в UTC граница to получалась '...23:59:59.999Z', что в MSK уже
 * 02:59:59.999 следующего дня — блок «Финансы» на /dashboard показывал
 * '16.05 – 23.05' вместо '16.05 – 22.05'.
 */
export function getFinancialWeek(date: Date): { from: Date; to: Date } {
  const ms = date.getTime()

  // Сдвигаем точку на +3 часа — теперь UTC-компоненты shifted-даты
  // совпадают с MSK-компонентами исходной date.
  const mskShifted = new Date(ms + MSK_OFFSET_MS)
  const y = mskShifted.getUTCFullYear()
  const m = mskShifted.getUTCMonth()
  const d = mskShifted.getUTCDate()
  const dow = mskShifted.getUTCDay() // 0=Sun..6=Sat — MSK day-of-week

  // Откатить назад до субботы (Сб=6 в MSK).
  const backToSat = (dow - 6 + 7) % 7

  // from = "MSK-полночь" этой субботы → как UTC-точка = MSK-полночь − 3 часа.
  const fromUtcMidnight = Date.UTC(y, m, d - backToSat, 0, 0, 0, 0)
  const from = new Date(fromUtcMidnight - MSK_OFFSET_MS)

  // to = "Пт 23:59:59.999 МСК" → как UTC-точка.
  const toUtcEndOfDay = Date.UTC(y, m, d - backToSat + 6, 23, 59, 59, 999)
  const to = new Date(toUtcEndOfDay - MSK_OFFSET_MS)

  return { from, to }
}

export function getPreviousFinancialWeek(date: Date): { from: Date; to: Date } {
  const current = getFinancialWeek(date)
  const from = new Date(current.from)
  from.setDate(from.getDate() - 7)
  const to = new Date(current.to)
  to.setDate(to.getDate() - 7)
  return { from, to }
}

/**
 * Финансовая неделя Сб→Пт для фильтров по @db.Date Order.deliveryDate.
 *
 * getFinancialWeek().from = UTC-инстант МСК-полуночи субботы (Пт 21:00Z). Для
 * @db.Date Prisma усекает инстант до его UTC-КАЛЕНДАРНОЙ даты (пятницы) → gte
 * втягивает лишний день прошлой фин-недели (class-of-bug «Два midnight»). Здесь
 * from = UTC-ПОЛНОЧЬ МСК-субботы (Сб 00:00 UTC, чья UTC-дата = суббота), как и
 * хранится @db.Date. `to` не отличается от getFinancialWeek — конец дня Пт через
 * mskEndOfDayUtc уже усекается в правильную дату.
 *
 * Для DateTime-полей (createdAt, eventDate) использовать обычный getFinancialWeek —
 * там МСК-инстант корректен (Postgres не усекает DateTime).
 */
export function getFinancialWeekForDbDate(date: Date): { from: Date; to: Date } {
  const base = getFinancialWeek(date)
  // getMskCalendarDayUtc берёт МСК-календарный день инстанта: Пт 21:00Z → Сб → Сб 00:00 UTC.
  return { from: getMskCalendarDayUtc(base.from, 0), to: base.to }
}

/**
 * true, если заданная дата попадает в текущую финансовую неделю (Сб-Пт).
 */
export function isInCurrentFinancialWeek(date: Date): boolean {
  const { from, to } = getFinancialWeek(new Date())
  return date >= from && date <= to
}

export type ReportPreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'custom'
  // Дашбордные rolling-окна (Sprint 7.46). Существуют рядом со старыми
  // календарными ключами — /analytics и /reports их не используют.
  | 'week_to_date'
  | 'month_rolling'
  | 'last_3_months'

// ── Хелперы для дашбордных rolling-окон (Sprint 7.46). ───────────────────
// Все вычисления в МСК через ту же арифметику UTC-миллисекунд, что и
// getFinancialWeek: МСК-стенные компоненты получаем сдвигом +3ч, целевые
// инстанты строим как Date.UTC(...) − MSK_OFFSET_MS. Намеренно НЕ используем
// date-fns subMonths (он считает в TZ процесса через local getMonth/setMonth)
// и НЕ setHours — иначе на Vercel (UTC) границы съедут на 3 часа / на день.

interface MskYmd {
  y: number
  m: number // 0-based month index
  d: number
}

/** МСК-компоненты календарного дня для заданного момента. */
function mskTodayYmd(now: Date): MskYmd {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS)
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() }
}

/** «МСК 00:00:00.000 этой даты» как UTC-точка. */
function mskStartOfDayUtc({ y, m, d }: MskYmd): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - MSK_OFFSET_MS)
}

/** «МСК 23:59:59.999 этой даты» как UTC-точка. */
function mskEndOfDayUtc({ y, m, d }: MskYmd): Date {
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - MSK_OFFSET_MS)
}

/** Кол-во дней в месяце (TZ-safe, чистая UTC-арифметика; day 0 = последний день пред. месяца). */
function daysInMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * Вычитает n месяцев из МСК-даты с clamp на последний день целевого месяца:
 * 31 марта − 1 мес → 28 февраля (а не 3 марта из-за JS Date overflow).
 * Возвращает UTC-полночь МСК-календарного дня (как getMskCalendarDayUtc), НЕ
 * UTC-инстант МСК-полночи (mskStartOfDayUtc): для @db.Date Order.deliveryDate
 * Prisma усекает инстант Пт-21:00Z до даты пред.дня → лишний день в начале окна
 * (class-of-bug «Два midnight»).
 */
function mskSubMonthsStartOfDay(today: MskYmd, n: number): Date {
  let monthIdx = today.m - n
  let year = today.y
  while (monthIdx < 0) {
    monthIdx += 12
    year -= 1
  }
  const day = Math.min(today.d, daysInMonthUtc(year, monthIdx))
  return new Date(Date.UTC(year, monthIdx, day, 0, 0, 0))
}

export interface PeriodRange {
  from: Date
  to: Date
  label: string
}

export function getPresetRange(preset: ReportPreset, customFrom?: string, customTo?: string): PeriodRange {
  // Всё считаем от МСК-календарного «сегодня» (Vercel = UTC: local setHours /
  // getMonth / getDate в окне 00:00–03:00 МСК дают вчерашний день).
  //
  // КОНТРАКТ границ (для всех пресетов):
  //   from = UTC-полночь первого МСК-дня (как хранится @db.Date deliveryDate);
  //   to   = «МСК 23:59:59.999 последнего дня» как UTC-инстант (XT20:59:59.999Z) —
  //          его UTC-дата и МСК-дата совпадают, поэтому он корректен и для
  //          `deliveryDate lte: to`, и для DateTime-фильтров, и для toDbDateRange.
  const realNow = new Date()
  const today = mskTodayYmd(realNow)
  const utcMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d))

  switch (preset) {
    case 'today': {
      return { from: utcMidnight(today.y, today.m, today.d), to: mskEndOfDayUtc(today), label: 'Сегодня' }
    }
    case 'yesterday': {
      const y = ymdOf(utcMidnight(today.y, today.m, today.d - 1))
      return { from: utcMidnight(y.y, y.m, y.d), to: mskEndOfDayUtc(y), label: 'Вчера' }
    }
    case 'this_week': {
      // @db.Date: from = UTC-полночь МСК-субботы (не Пт 21:00Z — иначе лишняя пятница).
      const { from, to } = getFinancialWeekForDbDate(realNow)
      return { from, to, label: 'Эта финансовая неделя' }
    }
    case 'last_week': {
      const { from, to } = getFinancialWeekForDbDate(realNow)
      return {
        from: new Date(from.getTime() - 7 * DAY_MS),
        to: new Date(to.getTime() - 7 * DAY_MS),
        label: 'Прошлая финансовая неделя',
      }
    }
    case 'this_month': {
      return { from: utcMidnight(today.y, today.m, 1), to: mskEndOfDayUtc(today), label: 'Этот месяц' }
    }
    case 'last_month': {
      const lastDay = ymdOf(utcMidnight(today.y, today.m, 0))
      return { from: utcMidnight(today.y, today.m - 1, 1), to: mskEndOfDayUtc(lastDay), label: 'Прошлый месяц' }
    }
    case 'this_quarter': {
      const q = Math.floor(today.m / 3)
      return { from: utcMidnight(today.y, q * 3, 1), to: mskEndOfDayUtc(today), label: 'Этот квартал' }
    }
    case 'last_quarter': {
      const q = Math.floor(today.m / 3)
      const lastDay = ymdOf(utcMidnight(today.y, q * 3, 0))
      return { from: utcMidnight(today.y, (q - 1) * 3, 1), to: mskEndOfDayUtc(lastDay), label: 'Прошлый квартал' }
    }
    case 'this_year': {
      return { from: utcMidnight(today.y, 0, 1), to: mskEndOfDayUtc(today), label: 'Этот год' }
    }
    // ── Дашбордные rolling-окна (Sprint 7.46). `to` = конец сегодняшнего
    //    МСК-дня (никогда не в будущем). dashboard-stats использует lte:to.
    case 'week_to_date': {
      // @db.Date: from = UTC-полночь МСК-субботы (не МСК-инстант Пт 21:00Z, иначе
      // gte втянет лишнюю пятницу прошлой фин-недели — «Два midnight»).
      const { from } = getFinancialWeekForDbDate(realNow)
      return { from, to: mskEndOfDayUtc(today), label: 'Неделя по сегодня' }
    }
    case 'month_rolling': {
      return { from: mskSubMonthsStartOfDay(today, 1), to: mskEndOfDayUtc(today), label: 'Месяц по сегодня' }
    }
    case 'last_3_months': {
      return { from: mskSubMonthsStartOfDay(today, 3), to: mskEndOfDayUtc(today), label: '3 месяца по сегодня' }
    }
    case 'custom':
    default: {
      const fromYmd = parseCustomDay(customFrom) ?? today
      const toYmd = parseCustomDay(customTo) ?? today
      return {
        from: utcMidnight(fromYmd.y, fromYmd.m, fromYmd.d),
        to: mskEndOfDayUtc(toYmd),
        label: 'Произвольный период',
      }
    }
  }
}

/** Y/M/D UTC-компонент (для Date, уже являющегося UTC-полночью календарного дня). */
function ymdOf(utcMidnightDate: Date): MskYmd {
  return {
    y: utcMidnightDate.getUTCFullYear(),
    m: utcMidnightDate.getUTCMonth(),
    d: utcMidnightDate.getUTCDate(),
  }
}

/**
 * Custom-граница из URL. 'YYYY-MM-DD' — календарный день как есть (без TZ);
 * иное парсимое значение (ISO-инстант) — МСК-календарный день этого инстанта.
 * Невалидное/пустое → null (вызывающий падает на «сегодня»).
 */
function parseCustomDay(value: string | undefined): MskYmd | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) }
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return null
  return mskTodayYmd(dt)
}

/**
 * Границы фильтра по @db.Date колонке (Order.deliveryDate) для ВКЛЮЧИТЕЛЬНОГО
 * диапазона МСК-календарных дней [from, to].
 *
 * Возвращает half-open { gte, lt } из UTC-полуночей: gte = первый МСК-день,
 * lt = день ПОСЛЕ последнего МСК-дня. Prisma усекает Date до UTC-даты, поэтому
 * передавать в @db.Date-фильтр нужно именно UTC-полночи (не МСК-инстанты).
 *
 * Принимаемые входы (оба трактуются по МСК-календарю):
 *   - UTC-полночь дня (2026-10-19T00:00:00Z → 19.10);
 *   - UTC-инстант МСК-полночи (2026-10-18T21:00:00Z → 19.10);
 *   - любой момент внутри МСК-дня, в т.ч. «МСК 23:59:59.999» (…T20:59:59.999Z)
 *     и `new Date()`.
 * НЕ передавайте UTC-конец суток (…T23:59:59.999Z) — это уже 02:59 МСК
 * следующего дня, диапазон вырастет на день.
 *
 * Если to раньше from — пустой диапазон (lt === gte).
 */
export function toDbDateRange(from: Date, to: Date): { gte: Date; lt: Date } {
  const gte = getMskCalendarDayUtc(from, 0)
  const lt = getMskCalendarDayUtc(to, 1)
  return { gte, lt: lt.getTime() < gte.getTime() ? gte : lt }
}

/** Число дней в half-open диапазоне UTC-полуночей { gte, lt } (результат toDbDateRange). */
export function countDbDays(range: { gte: Date; lt: Date }): number {
  return Math.round((range.lt.getTime() - range.gte.getTime()) / DAY_MS)
}
