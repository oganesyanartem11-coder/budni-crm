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

function hasDateHint(lower: string): boolean {
  return DATE_HINT_RE.test(lower) || WEEKDAY_ABBR_RE.test(lower)
}

// Верхняя граница безопасности. parseChangeIntent уже режет прошлое и >14 дней —
// это лишь страховка на случай изменения того контракта.
const MAX_FUTURE_DAYS = 60

export async function extractDeliveryDateFromText(
  text: string,
  nowMsk: Date,
): Promise<Date | null> {
  try {
    if (!text || !hasDateHint(text.toLowerCase())) return null

    const intent = await parseChangeIntent(text, {
      clientName: 'клиент',
      today: nowMsk,
      availableMealTypes: [],
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
