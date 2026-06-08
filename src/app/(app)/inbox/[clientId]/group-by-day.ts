import { toMskDateString } from '@/lib/utils/msk-window'

/**
 * Pure helpers for grouping inbox thread messages by MSK calendar day and
 * rendering the sticky «date chip» label. Все функции детерминированы — `now`
 * (или today-ключ) передаётся параметром, Date.now() внутри НЕ вызывается,
 * чтобы тесты могли пиновать момент.
 */

/** Минимальный контракт сообщения, нужный для группировки. */
export interface DayGroupableMessage {
  createdAt: Date | string
}

export interface DayGroup<T extends DayGroupableMessage> {
  /** МСК-календарный день 'YYYY-MM-DD'. */
  dayKey: string
  messages: T[]
}

// Названия месяцев в родительном падеже («6 июня»). Индекс = 1-based месяц − 1.
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

function toDate(v: Date | string): Date {
  return typeof v === 'string' ? new Date(v) : v
}

/**
 * Группирует сообщения по МСК-календарному дню, сохраняя порядок входного
 * массива (и порядок дней по первому появлению). Каждый день — отдельная
 * группа с ключом 'YYYY-MM-DD' и своими сообщениями.
 */
export function groupMessagesByMskDay<T extends DayGroupableMessage>(
  messages: readonly T[],
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  let current: DayGroup<T> | null = null

  for (const m of messages) {
    const dayKey = toMskDateString(toDate(m.createdAt))
    if (!current || current.dayKey !== dayKey) {
      current = { dayKey, messages: [m] }
      groups.push(current)
    } else {
      current.messages.push(m)
    }
  }

  return groups
}

/**
 * Метка для date-chip:
 *   «Сегодня»       — если день == МСК-сегодня (по `nowMsk`)
 *   «Вчера»         — если день == МСК-вчера
 *   «6 июня»        — тот же год, что у `nowMsk`
 *   «6 июня 2025»   — другой год
 *
 * @param mskDayKey день в формате 'YYYY-MM-DD' (МСК-календарный)
 * @param nowMsk опорный момент «сейчас» — передаётся явно (детерминизм)
 */
export function formatDayChipLabel(mskDayKey: string, nowMsk: Date): string {
  const todayKey = toMskDateString(nowMsk)
  const yesterdayKey = toMskDateString(new Date(nowMsk.getTime() - 24 * 60 * 60 * 1000))

  if (mskDayKey === todayKey) return 'Сегодня'
  if (mskDayKey === yesterdayKey) return 'Вчера'

  const [yearStr, monthStr, dayStr] = mskDayKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr) // 1-based
  const day = Number(dayStr)
  const monthName = MONTHS_GENITIVE[month - 1] ?? monthStr

  const nowYear = Number(todayKey.slice(0, 4))
  if (year === nowYear) return `${day} ${monthName}`
  return `${day} ${monthName} ${year}`
}
