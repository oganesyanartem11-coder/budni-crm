/**
 * Формирование текста «Доброе утро. Сегодня на доставку» (П13, MEGA-3).
 *
 * Чистая функция — не ходит в БД, не шлёт TG. Принимает уже выбранные заказы
 * (отфильтрованные по статусам доставки на стороне cron-роута) и собирает
 * детерминированный текст для группового чата.
 *
 * Группировка: одна строка на ЛОКАЦИЮ (несколько заказов одной точки —
 * суммируются). Сортировка строк — по имени локации алфавитно (ru).
 * Итог — суммарные порции и ₽.
 * Финальная фраза «от Бори» — ротация по дню недели МСК (детерминированно).
 */

export interface NineAmOrderRow {
  locationId: string
  locationName: string
  portions: number
  totalPrice: number
}

/** 5 фраз «от Бори». Ротация по дню недели МСК (Пн..Вс → индекс 0..6 mod 5). */
const BORIS_PHRASES = [
  'День будет насыщенный',
  'Кухня готова',
  'Поехали',
  'Шеф ждёт цифры',
  'Считаю минуты до отгрузки',
] as const

/** День недели МСК как 0..6 (Пн=0 … Вс=6). UTC+3 без DST (Москва). */
function mskWeekdayIndex(now: Date): number {
  const mskMs = now.getTime() + 3 * 3600_000
  const dow = new Date(mskMs).getUTCDay() // Sun=0..Sat=6
  return (dow + 6) % 7 // Mon=0..Sun=6
}

/** Детерминированная фраза «от Бори» по дню недели МСК. */
export function borisPhraseForDay(now: Date): string {
  return BORIS_PHRASES[mskWeekdayIndex(now) % BORIS_PHRASES.length]
}

/** Форматирует ₽ с разделителем тысяч (пробел), без копеек. */
function formatRub(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Собирает финальный текст сводки.
 *
 * @param rows             заказы на сегодня (уже отфильтрованы по статусам доставки)
 * @param now              момент запуска (для выбора фразы по дню недели МСК)
 * @param escape           функция HTML-экранирования имён локаций (parseMode='HTML')
 * @param deliveryRevenue  Волна 4: сервисная выручка (доставка) за сегодня, ₽.
 *                         Если > 0 — добавляется отдельная строка «Доставка: X ₽».
 *                         food-итог («Итого: … ₽») остаётся прежним.
 */
export function buildNineAmSummary(
  rows: NineAmOrderRow[],
  now: Date,
  escape: (s: string) => string = (s) => s,
  deliveryRevenue = 0
): string {
  const phrase = borisPhraseForDay(now)

  if (rows.length === 0) {
    return (
      `☀️ Доброе утро. Сегодня на доставку:\n\n` +
      `Заказов на сегодня пока нет.\n\n` +
      `— ${phrase}`
    )
  }

  // Группировка по локации (суммируем порции и ₽).
  const byLocation = new Map<string, { locationName: string; portions: number; total: number }>()
  for (const r of rows) {
    const existing = byLocation.get(r.locationId)
    if (existing) {
      existing.portions += r.portions
      existing.total += r.totalPrice
    } else {
      byLocation.set(r.locationId, {
        locationName: r.locationName,
        portions: r.portions,
        total: r.totalPrice,
      })
    }
  }

  const grouped = Array.from(byLocation.values()).sort((a, b) =>
    a.locationName.localeCompare(b.locationName, 'ru')
  )

  const totalPortions = grouped.reduce((s, g) => s + g.portions, 0)
  const totalRub = grouped.reduce((s, g) => s + g.total, 0)

  const lines = grouped.map(
    (g) => `${escape(g.locationName)} — ${g.portions} порций`
  )

  // Волна 4: сервисная выручка (доставка) — отдельной строкой, food-итог не трогаем.
  const deliveryLine =
    deliveryRevenue > 0 ? `\nДоставка: ${formatRub(deliveryRevenue)} ₽` : ''

  return (
    `☀️ Доброе утро. Сегодня на доставку:\n\n` +
    lines.join('\n') +
    `\n\nИтого: ${totalPortions} порций, ${formatRub(totalRub)} ₽${deliveryLine}\n\n` +
    `— ${phrase}`
  )
}
