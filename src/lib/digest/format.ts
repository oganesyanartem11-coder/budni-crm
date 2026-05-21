import { formatMoney } from '@/lib/utils/format'

const DAY_NAMES_SHORT_BY_DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const

/**
 * Тонкая обёртка над formatMoney — единая точка для всех дайджестов,
 * чтобы при изменении формата (₽ → руб., запятая → разделитель) править
 * только тут.
 */
export function formatMoneyRu(amount: number): string {
  return formatMoney(amount)
}

/**
 * Сравнение «curr vs prev» с округлением до 1 знака. Возвращает строку
 * вида «+12% к прошлой неделе» / «−5% к прошлой неделе».
 *
 * null если prev = 0 — невозможно посчитать процент.
 */
export function formatWowLine(curr: number, prev: number): string | null {
  if (prev === 0) return null
  const pct = Math.round(((curr - prev) / prev) * 1000) / 10
  if (Math.abs(pct) < 0.1) return 'на уровне прошлой недели'
  const sign = pct > 0 ? '+' : '−'
  return `${sign}${Math.abs(pct)}% к прошлой неделе`
}

/** Короткое русское название дня недели по getDay(): «Сб», «Пн»... */
export function formatDayName(date: Date): string {
  return DAY_NAMES_SHORT_BY_DOW[date.getDay()]
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** «22.05» — день и месяц без года. */
export function formatDate(date: Date): string {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`
}

/** «22.05 (Пт)» — для заголовков дайджестов. */
export function formatDateWithDay(date: Date): string {
  return `${formatDate(date)} (${formatDayName(date)})`
}
