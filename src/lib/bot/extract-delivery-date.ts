import { parseChangeIntent } from './parse-change-intent'

/**
 * Извлечение даты доставки из ТЕКСТА клиента (Волна 2, баг A/B).
 *
 * Зачем: ветка handleBotResponse раньше слепо брала дату из BotConversation
 * (которая могла «висеть» на старом/прошедшем дне). Здесь достаём дату из самого
 * сообщения, чтобы вызвать приоритет «дата из текста > дата беседы».
 *
 * Контракт:
 *  - дешёвый regex-гейт: нет признака даты в тексте → null СРАЗУ, без LLM
 *    (обычные числовые ответы DYNAMIC-клиентов вроде «8» не трогаем — ни
 *    латентности, ни изменения поведения);
 *  - есть признак → используем СУЩЕСТВУЮЩИЙ parseChangeIntent (он же валидирует
 *    окно [сегодня, +14] по МСК и режет прошлое/далёкое);
 *  - результат приводим к тому же виду, что Order.deliveryDate (@db.Date —
 *    UTC-полночь МСК-календарного дня), тем же контрактом, что и сам парсер;
 *  - любая ошибка/таймаут/NONE → null (падаем на текущее поведение).
 */

// Признаки даты (по нижнему регистру текста). Корни месяцев ловят и «15 июля».
// \b в JS не работает с кириллицей, поэтому по словам-корням идём подстрокой
// (ложное срабатывание = лишь один лишний вызов LLM, который вернёт null).
const DATE_HINT_RE =
  /(завтра|послезавтра|сегодня|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|\d{1,2}[./]\d{1,2})/

// Сокращения дней недели — с кириллице-осознанными границами (lookaround),
// чтобы «пн/вт/ср/чт/пт/сб/вс» не ловились внутри слов («все», «автобус»).
const WEEKDAY_ABBR_RE = /(?<![а-яё])(пн|вт|ср|чт|пт|сб|вс)(?![а-яё])/

export function hasDateHint(lower: string): boolean {
  return DATE_HINT_RE.test(lower) || WEEKDAY_ABBR_RE.test(lower)
}

// Верхняя граница безопасности. parseChangeIntent уже режет прошлое и >14 дней —
// это лишь страховка на случай изменения того контракта.
const MAX_FUTURE_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/(?<![а-яё])(понедельник[а-яё]*|пн)(?![а-яё])/g, 1],
  [/(?<![а-яё])(вторник[а-яё]*|вт)(?![а-яё])/g, 2],
  [/(?<![а-яё])(сред[аеуы]|ср)(?![а-яё])/g, 3],
  [/(?<![а-яё])(четверг[а-яё]*|чт)(?![а-яё])/g, 4],
  [/(?<![а-яё])(пятниц[аеуы]|пт)(?![а-яё])/g, 5],
  [/(?<![а-яё])(суббот[аеуы]|сб)(?![а-яё])/g, 6],
  [/(?<![а-яё])(воскресень[еяю]|вс)(?![а-яё])/g, 0],
]
const MONTH_ROOTS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр']

interface DateMention {
  index: number
  date: Date // UTC-полночь МСК-дня
}

/** МСК-«сегодня» как UTC-полночь календарного дня. */
function mskToday(now: Date): Date {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()))
}

/** День/месяц без года → ближайшая такая дата (дальше ~4 мес. в прошлом = следующий год). */
function resolveDayMonth(today: Date, day: number, month: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  let y = today.getUTCFullYear()
  let d = new Date(Date.UTC(y, month - 1, day))
  if (d.getUTCMonth() !== month - 1) return null
  if (today.getTime() - d.getTime() > 120 * DAY_MS) {
    y += 1
    d = new Date(Date.UTC(y, month - 1, day))
  }
  return d
}

/**
 * Упоминание отрицается: «а не на сегодня», «не завтра». Смотрим короткое окно
 * перед словом-датой.
 */
function isNegated(lower: string, index: number): boolean {
  const before = lower.slice(Math.max(0, index - 8), index)
  return /(^|[^а-яё])не\s+(на\s+|в\s+|во\s+)?$/.test(before)
}

/**
 * Детерминированный разбор даты из текста клиента — без LLM. 07–08.10 Haiku
 * терял «На завтра 7 обедов» (упоминание обеда при пустом списке приёмов пищи
 * → NONE) и «На пятницу 7, а не на сегодня!» (две даты + тон → NONE), и заказ
 * уезжал на дату вчерашней беседы.
 *
 * @returns 'YYYY-MM-DD' — ровно одна дата (не считая отрицаемых);
 *          null — даты нет; 'ambiguous' — несколько разных дат.
 */
export function extractDateDeterministic(text: string, now: Date): string | 'ambiguous' | null {
  const lower = text.toLowerCase().replace(/ё/g, 'е')
  const today = mskToday(now)
  const mentions: DateMention[] = []
  const add = (index: number, date: Date | null) => {
    if (date && !isNegated(lower, index)) mentions.push({ index, date })
  }

  for (const m of lower.matchAll(/(?<![а-я])(послезавтра|завтра|сегодня)(?![а-я])/g)) {
    const offset = m[1] === 'послезавтра' ? 2 : m[1] === 'завтра' ? 1 : 0
    add(m.index!, new Date(today.getTime() + offset * DAY_MS))
  }
  for (const [re, dow] of WEEKDAY_WORDS) {
    for (const m of lower.matchAll(re)) {
      const diff = (dow - today.getUTCDay() + 7) % 7
      add(m.index!, new Date(today.getTime() + diff * DAY_MS))
    }
  }
  for (const m of lower.matchAll(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d])/g)) {
    add(m.index!, resolveDayMonth(today, Number(m[1]), Number(m[2])))
  }
  const monthRe = new RegExp(`(?<![\\d])(\\d{1,2})\\s*(?:-?го\\s+)?(${MONTH_ROOTS.join('|')})[а-я]*`, 'g')
  for (const m of lower.matchAll(monthRe)) {
    const month = MONTH_ROOTS.findIndex((root) => new RegExp(`^${root}`).test(m[2])) + 1
    add(m.index!, resolveDayMonth(today, Number(m[1]), month))
  }
  // «на 9-е», «9-го», «9 числа» — число текущего месяца (прошло → следующий).
  for (const m of lower.matchAll(/(?<![\d.])(\d{1,2})\s*(?:-?(?:е|го)(?![а-я])|числ)/g)) {
    const day = Number(m[1])
    let d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day))
    if (d.getUTCDate() !== day) continue
    if (d.getTime() < today.getTime()) {
      d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day))
      if (d.getUTCDate() !== day) continue
    }
    add(m.index!, d)
  }

  const distinct = Array.from(new Set(mentions.map((m) => m.date.toISOString().slice(0, 10))))
  if (distinct.length === 0) return null
  if (distinct.length > 1) return 'ambiguous'
  return distinct[0]
}

export async function extractDeliveryDateFromText(
  text: string,
  nowMsk: Date,
): Promise<Date | null> {
  try {
    if (!text || !hasDateHint(text.toLowerCase())) return null

    // 1) Без LLM: «завтра», «на пятницу», «9.10», «9 октября», «а не на сегодня».
    const exact = extractDateDeterministic(text, nowMsk)
    if (exact && exact !== 'ambiguous') return new Date(`${exact}T00:00:00.000Z`)

    // 2) Сложный случай — LLM. Все приёмы пищи разрешены: раньше пустой список
    // превращал любое «обедов» в NONE и дата терялась.
    const intent = await parseChangeIntent(text, {
      clientName: 'клиент',
      today: nowMsk,
      availableMealTypes: ['ЗАВТРАК', 'ОБЕД', 'УЖИН'],
    })
    if (intent.action !== 'CHANGE' || !intent.date) return null

    // @db.Date-контракт: UTC-полночь МСК-календарного дня (как в
    // parse-change-intent.ts, где та же строка используется для валидации даты).
    const dateUtc = new Date(`${intent.date}T00:00:00.000Z`)
    if (Number.isNaN(dateUtc.getTime())) return null

    const maxUtc = new Date(nowMsk.getTime() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000)
    if (dateUtc.getTime() > maxUtc.getTime()) return null

    return dateUtc
  } catch (err) {
    console.error('[extract-delivery-date] failed, fallback to null', err)
    return null
  }
}

const RANGE_HINT_RE =
  /(^|[^а-яё])(с|со)\s+\d{1,2}([.\s]|$)|(^|[^а-яё])по\s+\d{1,2}(\s*(-?го|числ|[.])|\s+(янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек))|(^|[^а-яё])(с|со)\s+(понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)|всю\s+(следующую\s+)?неделю|до\s+конца\s+недели|каждый\s+день/i

/**
 * Дешёвый фильтр перед LLM: похоже ли сообщение на период дат («с 7 по 14»,
 * «с понедельника по пятницу», «всю неделю»). Используют вопрос дня и STICKY —
 * период не должен стать числом на завтра или новой постоянной.
 */
export function looksLikeDateRange(text: string): boolean {
  return RANGE_HINT_RE.test(text)
}
