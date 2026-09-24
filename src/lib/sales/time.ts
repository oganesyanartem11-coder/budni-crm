import {
  getMskCalendarDayUtc,
  getMskHoursMinutes,
  parseWindowToDate,
  toMskDateString,
} from '@/lib/utils/msk-window'

/**
 * Sprint 8.0 «Продажи»: слоты задач воронки в МСК. Хранение — UTC DateTime,
 * расчёт «сегодня/завтра/09:30» — только через МСК-helper'ы (на Vercel сервер в
 * UTC, поэтому никаких setHours/new Date(y,m,d)). Чистые функции: `now`
 * передаётся явно, модуль годится и серверу, и клиентским компонентам.
 */

const MINUTE_MS = 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** МСК-время «HH:mm» на МСК-день (сегодня + dayOffset) как UTC-инстант. */
export function atMsk(dayOffset: number, hhmm: string, now: Date = new Date()): Date {
  const result = parseWindowToDate(hhmm, getMskCalendarDayUtc(now, dayOffset))
  if (!result) throw new Error(`atMsk: неверное время «${hhmm}» (нужно HH:mm)`)
  return result
}

/** Минуты от МСК-полуночи для момента. */
function mskMinutesOfDay(d: Date): number {
  const { hours, minutes } = getMskHoursMinutes(d)
  return hours * 60 + minutes
}

/**
 * Когда связаться с новой заявкой: в рабочее время (МСК 09:00–19:59) — через
 * 15 минут; до 09:00 — сегодня 09:30; с 20:00 — завтра 09:30.
 */
export function nextContactSlot(now: Date = new Date()): Date {
  const minutes = mskMinutesOfDay(now)
  if (minutes >= 9 * 60 && minutes < 20 * 60) return new Date(now.getTime() + 15 * MINUTE_MS)
  if (minutes < 9 * 60) return atMsk(0, '09:30', now)
  return atMsk(1, '09:30', now)
}

export interface QuickSlots {
  inOneHour: Date
  /** Сегодня 18:00 МСК — только если сейчас раньше 17:30 МСК, иначе null. */
  todayEvening: Date | null
  tomorrow10: Date
  in3days10: Date
}

/** Быстрые слоты переноса/создания задачи. */
export function quickSlots(now: Date = new Date()): QuickSlots {
  return {
    inOneHour: new Date(now.getTime() + 60 * MINUTE_MS),
    todayEvening: mskMinutesOfDay(now) < 17 * 60 + 30 ? atMsk(0, '18:00', now) : null,
    tomorrow10: atMsk(1, '10:00', now),
    in3days10: atMsk(3, '10:00', now),
  }
}

/** Та же МСК-время, следующий МСК-день (кнопка «⏰ +1 день»). */
export function plusOneDay(dueAt: Date): Date {
  const { hours, minutes } = getMskHoursMinutes(dueAt)
  return atMsk(1, `${pad2(hours)}:${pad2(minutes)}`, dueAt)
}

/**
 * Пара полей формы (input type=date «YYYY-MM-DD» + type=time «HH:mm», оба в МСК)
 * → UTC-инстант. Невалидный ввод → null.
 */
export function fromMskInput(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const day = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(day.getTime())) return null
  return parseWindowToDate(time, day)
}

/** UTC-инстант → значения для input type=date / type=time в МСК. */
export function toMskInput(d: Date): { date: string; time: string } {
  const { hours, minutes } = getMskHoursMinutes(d)
  return { date: toMskDateString(d), time: `${pad2(hours)}:${pad2(minutes)}` }
}
