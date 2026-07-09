/**
 * Фейк клиента Метрики для полигона: сигнатуры готовых срезов один в один
 * с src/lib/boris-direct/metrika-client.ts, данные — из наблюдаемых дней
 * контекста (DayObservables.metrika / metrikaByUtm).
 *
 * Диапазон дат 'YYYY-MM-DD' ↔ виртуальные дни через mskStringToDay.
 * bounceRate — доля 0..1, как отдаёт движок мира (конвенция полигона).
 *
 * Сырой metrikaStat в симуляции не поддержан (мозг зовёт только готовые
 * срезы) — бросает громкую ошибку, чтобы новый вызов не прошёл незамеченным.
 */

import { dayToMskString, getCtx, mskStringToDay } from './context'
import type { DayObservables } from '../types'
import type { MetrikaStatResponse } from '../../src/lib/boris-direct/metrika-client'

// Паритет экспортов типов с реальным модулем (type-only — стирается).
export type {
  MetrikaStatResponse,
  MetrikaStatRow,
} from '../../src/lib/boris-direct/metrika-client'

/** Единый источник-строка всех срезов симуляции (весь трафик мира — Директ). */
const SIM_TRAFFIC_SOURCE = 'yandex-direct'

// ---------- Ошибки (зеркало реального класса; в симуляции никто не ловит) ----------

export class MetrikaApiError extends Error {
  readonly status: number
  readonly detail?: string

  constructor(status: number, detail?: string) {
    super(`[metrika] HTTP ${status}${detail ? `: ${detail}` : ''}`)
    this.name = 'MetrikaApiError'
    this.status = status
    this.detail = detail
  }
}

// ---------- Внутреннее: дни диапазона ----------

/** Наблюдаемые дни, попадающие в [dateFrom..dateTo] (обе границы включительно). */
function daysInRange(dateFrom: string, dateTo: string): DayObservables[] {
  const ctx = getCtx()
  const from = mskStringToDay(dateFrom)
  const to = mskStringToDay(dateTo)
  return ctx.days.filter((d) => d.day >= from && d.day <= to)
}

/** Округление долей до 4 знаков — как в движке мира. */
function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0
}

// ---------- Сырой отчёт: не поддержан ----------

export async function metrikaStat(params: Record<string, string>): Promise<MetrikaStatResponse> {
  throw new Error(
    `[sim/fakes/metrika-client] metrikaStat не поддержан в симуляции (unsupported in sim): ${JSON.stringify(params)}`
  )
}

// ---------- Готовые срезы под цель «Заявка» ----------

/** Визиты и заявки по дням — по одной строке на каждый наблюдаемый день диапазона. */
export async function getGoalStatsByDay(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ date: string; visits: number; goalReaches: number }>> {
  return daysInRange(dateFrom, dateTo).map((d) => ({
    date: dayToMskString(d.day),
    visits: d.metrika.visits,
    goalReaches: d.metrika.goalReaches,
  }))
}

/** Источники: одна строка 'yandex-direct' с агрегатом за диапазон (bounce — взвешенно по визитам). */
export async function getGoalStatsBySource(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ source: string; visits: number; goalReaches: number; bounceRate: number }>> {
  const days = daysInRange(dateFrom, dateTo)
  if (days.length === 0) return []
  let visits = 0
  let goalReaches = 0
  let bounced = 0
  for (const d of days) {
    visits += d.metrika.visits
    goalReaches += d.metrika.goalReaches
    bounced += d.metrika.bounceRate * d.metrika.visits
  }
  return [
    {
      source: SIM_TRAFFIC_SOURCE,
      visits,
      goalReaches,
      bounceRate: visits > 0 ? round4(bounced / visits) : 0,
    },
  ]
}

/** Срез по UTM: агрегат metrikaByUtm за диапазон по utmTerm (кампания = id сценария). */
export async function getGoalStatsByUtm(
  dateFrom: string,
  dateTo: string
): Promise<
  Array<{
    utmSource: string
    utmCampaign: string
    utmTerm: string
    visits: number
    goalReaches: number
  }>
> {
  const ctx = getCtx()
  const byTerm = new Map<string, { visits: number; goalReaches: number }>()
  for (const d of daysInRange(dateFrom, dateTo)) {
    for (const row of d.metrikaByUtm) {
      const acc = byTerm.get(row.utmTerm) ?? { visits: 0, goalReaches: 0 }
      acc.visits += row.visits
      acc.goalReaches += row.goalReaches
      byTerm.set(row.utmTerm, acc)
    }
  }
  return [...byTerm.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([utmTerm, acc]) => ({
      utmSource: SIM_TRAFFIC_SOURCE,
      utmCampaign: ctx.world.config.id,
      utmTerm,
      visits: acc.visits,
      goalReaches: acc.goalReaches,
    }))
}

// ---------- Разведочные срезы (сессия «Прозрение»): устройства/демография/час ----------
// В базовом мире НЕТ размерности устройства/демографии/часа → пусто, диагнозы
// DEVICE_SKEW/AUDIENCE_WASTE молчат, линейка не меняется. ШАГ 3 может подложить
// перекос устройств через world.internal.deviceStats.

export async function getGoalStatsByDevice(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>> {
  const over = (getCtx().world.internal as {
    deviceStats?: Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>
  } | undefined)?.deviceStats
  if (!over) return []
  // Отдаём только если окно захватывает хотя бы один наблюдаемый день.
  return daysInRange(dateFrom, dateTo).length > 0 ? over : []
}

export async function getGoalStatsByDemographics(
  _dateFrom: string,
  _dateTo: string
): Promise<Array<{ gender: string; age: string; visits: number; goalReaches: number }>> {
  return []
}

export async function getGoalStatsByHour(
  _dateFrom: string,
  _dateTo: string
): Promise<Array<{ hour: string; visits: number; goalReaches: number }>> {
  return []
}

/** Пофразное поведение: мир не отдаёт (нейтрально) → поведенческие кандидаты молчат. */
export async function getGoalStatsByPhrase(
  _dateFrom: string,
  _dateTo: string
): Promise<
  Array<{ phrase: string; visits: number; bounceRate: number; avgDurationSec: number; goalReaches: number }>
> {
  return []
}

/** Страницы входа: в мире одна посадочная — '/' с агрегатом за диапазон. */
export async function getGoalStatsByLandingPage(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ path: string; visits: number; goalReaches: number }>> {
  const days = daysInRange(dateFrom, dateTo)
  if (days.length === 0) return []
  let visits = 0
  let goalReaches = 0
  for (const d of days) {
    visits += d.metrika.visits
    goalReaches += d.metrika.goalReaches
  }
  return [{ path: '/', visits, goalReaches }]
}
