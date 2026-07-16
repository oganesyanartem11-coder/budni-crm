/**
 * РУЧНОЙ ПРИЁМ ЗВОНКОВ (спринт 16.07). Пошли звонки при молчащей форме, невидимые для
 * аналитики (в LandingLead только формы). Владелец вносит звонок командой чата, Борис
 * создаёт лид-звонок (formType='phone_call', источник НЕИЗВЕСТЕН → utm/yclid=null) и даёт
 * ПОДСКАЗКУ «с какого запроса пришёл» по ВРЕМЕНИ — строго ГИПОТЕЗА, не атрибуция.
 *
 * Гардрейлы (по построению, см. attribution.isFromDirect / решалку):
 *  - phone_call не Директ (нет yclid/cpc) → не в «доставлено из Директа», не в знаменателе CPA;
 *  - нет yclid/utm_term → не кормит пофразную экономику/решалку ставок;
 *  - детекторы воронки/засухи (metrika_goal/Директ-отчёт) звонков не читают;
 *  - leads_zero изолируется filterOutCallLeads.
 *
 * Чистые: parseCallCommand (разбор+МСК-время) + buildCallHint (текст+meta). I/O
 * (создание лида + Метрика-подсказка) — в handleCallCommand. Живёт в telegram-хендлере,
 * НЕ в мозг-тике → полигон не трогает.
 */

import { prisma } from '@/lib/db/prisma'
import { getAdVisitsByPhraseHour } from './metrika-client'
import { CALL_FORM_TYPE, CALL_HINT_HOUR_RADIUS } from './config'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

function digitsOf(s: string): string {
  return (s.match(/\d/g) ?? []).join('')
}

/** МСК-компоненты (год/мес/день/час/мин) → UTC-инстант (МСК = UTC+3). */
function mskToUtc(y: number, mo1: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo1 - 1, d, h - 3, mi))
}

/** UTC-инстант → метка 'ДД.ММ ЧЧ:ММ' в МСК. */
function mskLabel(utc: Date): string {
  const m = new Date(utc.getTime() + MSK_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(m.getUTCDate())}.${p(m.getUTCMonth() + 1)} ${p(m.getUTCHours())}:${p(m.getUTCMinutes())}`
}

/** Час звонка в МСК (0..23) из UTC-инстанта. */
export function callHourMsk(utc: Date): number {
  return new Date(utc.getTime() + MSK_OFFSET_MS).getUTCHours()
}

/** МСК-день звонка 'YYYY-MM-DD' (для запроса Метрики за день). */
export function callDayMsk(utc: Date): string {
  return new Date(utc.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

// ---------- Разбор команды ----------

export interface ParsedCallOk {
  kind: 'ok'
  phoneDigits: string
  /** Сырой телефон-токен (как ввели). */
  phoneRaw: string
  /** createdAt лида: UTC-инстант, соответствующий МСК-времени звонка. */
  atUtc: Date
  /** 'ДД.ММ ЧЧ:ММ' в МСК — для ответа владельцу. */
  atMskLabel: string
  comment: string
}
export interface ParsedCallInvalid {
  kind: 'invalid'
  error: string
}
export type ParsedCallCommand = ParsedCallOk | ParsedCallInvalid

const TIME_RE = /^(\d{1,2}):(\d{2})$/
const DATE_RE = /^(\d{1,2})\.(\d{1,2})$/

function validTime(h: number, mi: number): boolean {
  return Number.isInteger(h) && Number.isInteger(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59
}
function validDate(d: number, mo: number): boolean {
  return Number.isInteger(d) && Number.isInteger(mo) && d >= 1 && d <= 31 && mo >= 1 && mo <= 12
}

/**
 * Разбор «звонок <телефон> [ДД.ММ ЧЧ:ММ | вчера ЧЧ:ММ | сегодня ЧЧ:ММ | ЧЧ:ММ] [коммент]».
 * Вход — текст ПОСЛЕ префикса «борис,» (уже lower-case), начинается с «звонок». Время —
 * в МСК; без времени → now. Чистая: `now` передаётся (детерминизм).
 */
export function parseCallCommand(command: string, now: Date): ParsedCallCommand {
  // Кириллица не входит в \w, поэтому \b после «звонок» не срабатывает — режем префикс явно.
  const rest = command.replace(/^звонок/, '').trim()
  const tokens = rest.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'invalid', error: 'нужно: «звонок <телефон> [время] [коммент]»' }

  const phoneRaw = tokens[0]
  const phoneDigits = digitsOf(phoneRaw)
  if (phoneDigits.length < 4) {
    return { kind: 'invalid', error: 'не понял телефон (нужно ≥4 цифр — можно последние 4)' }
  }
  const after = tokens.slice(1)

  // МСК-«сейчас» (компоненты) из now.
  const mskNow = new Date(now.getTime() + MSK_OFFSET_MS)
  const nowY = mskNow.getUTCFullYear()
  const nowMo = mskNow.getUTCMonth() + 1
  const nowD = mskNow.getUTCDate()

  let atUtc = now
  let consumed = 0

  const timeAt = (idx: number): { h: number; mi: number } | null => {
    const m = after[idx]?.match(TIME_RE)
    if (!m) return null
    return { h: Number(m[1]), mi: Number(m[2]) }
  }

  if (after.length >= 2 && DATE_RE.test(after[0])) {
    // ДД.ММ ЧЧ:ММ
    const dm = after[0].match(DATE_RE)!
    const d = Number(dm[1])
    const mo = Number(dm[2])
    const t = timeAt(1)
    if (!t || !validDate(d, mo) || !validTime(t.h, t.mi)) {
      return { kind: 'invalid', error: 'не понял дату/время (нужно ДД.ММ ЧЧ:ММ, напр. 16.07 11:28)' }
    }
    atUtc = mskToUtc(nowY, mo, d, t.h, t.mi)
    consumed = 2
  } else if (after.length >= 2 && (after[0] === 'сегодня' || after[0] === 'вчера')) {
    const t = timeAt(1)
    if (!t || !validTime(t.h, t.mi)) {
      return { kind: 'invalid', error: `не понял время (нужно «${after[0]} ЧЧ:ММ»)` }
    }
    const base = after[0] === 'вчера' ? new Date(Date.UTC(nowY, nowMo - 1, nowD - 1)) : new Date(Date.UTC(nowY, nowMo - 1, nowD))
    atUtc = mskToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), t.h, t.mi)
    consumed = 2
  } else if (after.length >= 1 && TIME_RE.test(after[0])) {
    // голое ЧЧ:ММ → сегодня
    const t = timeAt(0)!
    if (!validTime(t.h, t.mi)) return { kind: 'invalid', error: 'не понял время (ЧЧ:ММ)' }
    atUtc = mskToUtc(nowY, nowMo, nowD, t.h, t.mi)
    consumed = 1
  }

  return {
    kind: 'ok',
    phoneDigits,
    phoneRaw,
    atUtc,
    atMskLabel: mskLabel(atUtc),
    comment: after.slice(consumed).join(' '),
  }
}

// ---------- Подсказка по времени ----------

export interface PhraseHourVisit {
  phrase: string
  /** Час МСК 0..23. */
  hour: number
  visits: number
}

export interface CallHintMeta {
  channel: 'phone_call'
  callHourMsk: number
  windowHours: number[]
  windowVisits: number
  windowPhrases: string[]
  dayVisits: number
  note: string
}

const HINT_NOTE = 'гипотеза по времени, не атрибуция'

/**
 * Подсказка «с какого запроса пришёл» по ВРЕМЕНИ: рекламные визиты в окне ±радиус
 * часов от часа звонка (первично) + контекст дня. СТРОГО гипотеза, дисклеймер всегда.
 * Чистая: rows уже собраны из Метрики (ad-фильтр, phrase×hour, МСК). 0 в окне — честно.
 */
export function buildCallHint(
  rows: PhraseHourVisit[],
  opts: { callHourMsk: number; dayVisits: number; radius?: number }
): { text: string; meta: CallHintMeta } {
  const radius = opts.radius ?? CALL_HINT_HOUR_RADIUS
  const windowHours: number[] = []
  for (let h = opts.callHourMsk - radius; h <= opts.callHourMsk + radius; h++) {
    if (h >= 0 && h <= 23) windowHours.push(h)
  }
  const inWindow = rows.filter((r) => windowHours.includes(r.hour))

  // Свернуть по фразе (фраза может быть в нескольких часах окна), сортировать по визитам.
  const byPhrase = new Map<string, number>()
  for (const r of inWindow) byPhrase.set(r.phrase, (byPhrase.get(r.phrase) ?? 0) + r.visits)
  const phrasesSorted = [...byPhrase.entries()].sort((a, b) => b[1] - a[1])
  const windowVisits = inWindow.reduce((s, r) => s + r.visits, 0)
  const windowPhrases = phrasesSorted.map(([p]) => p)

  const meta: CallHintMeta = {
    channel: 'phone_call',
    callHourMsk: opts.callHourMsk,
    windowHours,
    windowVisits,
    windowPhrases,
    dayVisits: opts.dayVisits,
    note: HINT_NOTE,
  }

  const hh = String(opts.callHourMsk).padStart(2, '0')
  let text: string
  if (windowVisits === 0) {
    text =
      `В час звонка (±${radius}ч, ~${hh}:00) рекламных визитов нет (0). ` +
      `За день ${opts.dayVisits} рекл. визитов. Это ${HINT_NOTE}.`
  } else {
    const list = phrasesSorted.map(([p, v]) => `«${p}»${v > 1 ? ` (${v})` : ''}`).join('; ')
    text =
      `В час звонка (±${radius}ч, ~${hh}:00) — ${windowVisits} рекл. визитов: ${list}. ` +
      `За день ${opts.dayVisits} рекл. визитов. Это ${HINT_NOTE}.`
  }
  return { text, meta }
}

// ---------- Оркестрация (I/O): создание лида + подсказка ----------

/**
 * Обработка команды «Борис, звонок …». Создаёт LandingLead (formType='phone_call',
 * createdAt=время звонка МСК, utm/yclid=null), тянет подсказку из Метрики (fail-safe:
 * подсказка не собралась → лид всё равно создан, в ответе оговорка), пишет подсказку в
 * meta. Штатную пересылку заявки в чат заказов НЕ триггерит. Возвращает текст ответа.
 */
export async function handleCallCommand(command: string, now: Date = new Date()): Promise<string> {
  const parsed = parseCallCommand(command, now)
  if (parsed.kind === 'invalid') {
    return `Не понял команду звонка: ${parsed.error}. Пример: «Борис, звонок 79991234567 16.07 11:28 стройка».`
  }

  // Подсказка по времени (Метрика read-only, OAuth, timezone=+03:00). Fail-safe.
  let hint: { text: string; meta: CallHintMeta } | null = null
  try {
    const day = callDayMsk(parsed.atUtc)
    const rows = await getAdVisitsByPhraseHour(day)
    const dayVisits = rows.reduce((s, r) => s + r.visits, 0)
    hint = buildCallHint(rows, { callHourMsk: callHourMsk(parsed.atUtc), dayVisits })
  } catch (err) {
    console.error('[boris-direct/calls] подсказка Метрики не собралась (лид создаём без неё)', err)
  }

  const last4 = parsed.phoneDigits.slice(-4)
  try {
    await prisma.landingLead.create({
      data: {
        formType: CALL_FORM_TYPE,
        phone: parsed.phoneRaw,
        phoneDigits: parsed.phoneDigits,
        source: 'boris_call_intake',
        // Источник НЕИЗВЕСТЕН — честно null (не выдумываем атрибуцию).
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        yclid: null,
        gclid: null,
        createdAt: parsed.atUtc,
        meta: JSON.parse(
          JSON.stringify({
            channel: 'phone_call',
            atMsk: parsed.atMskLabel,
            comment: parsed.comment || null,
            hint: hint?.meta ?? null,
            hintText: hint?.text ?? null,
          })
        ),
      },
    })
  } catch (err) {
    console.error('[boris-direct/calls] создание лида-звонка упало', err)
    return 'Не получилось записать звонок, смотри логи.'
  }

  const head = `Записал звонок …${last4} за ${parsed.atMskLabel}${parsed.comment ? ` (${parsed.comment})` : ''}.`
  const hintLine = hint ? `\n${hint.text}` : '\nПодсказку по времени собрать не удалось (Метрика недоступна) — записал без неё.'
  return head + hintLine
}
