/**
 * Фейк Reports API Директа для полигона: ТОЛЬКО fakePollReport(body) —
 * раннер подменяет им pollReport, остальное реального модуля (build*Body,
 * parseReportTsv) чистое и остаётся боевым.
 *
 * Семантика поллинга: пока ctx.reportDelayPolls > 0 — декремент и pending
 * (моделируем «отчёт готовится», мозг дожимает на следующем тике). Затем —
 * готовый TSV из наблюдаемых строк мира.
 *
 * ВАЖНО про лаг конверсий: queryRows КАЖДОГО DayObservables пересчитаны
 * движком «на момент этого дня» и содержат строки ВСЕХ прошедших дней —
 * конверсия дописывается в строку дня клика задним числом, когда заявка
 * материализуется. Поэтому отчёт строится из queryRows ПОСЛЕДНЕГО
 * наблюдаемого дня (свежайший взгляд Директа), отфильтрованных по диапазону
 * дат тела отчёта — как настоящий Директ, который на дату снятия отчёта уже
 * знает про «поздние» конверсии за прошлые дни.
 *
 * Формат TSV — как боевой (skipReportHeader/skipReportSummary): первая
 * строка — имена колонок из FieldNames через \t, дальше данные; пустые
 * значения Директа — '--' (Conversions при нуле, Ctr/AvgCpc без данных).
 */

import { dayToMskString, getCtx, mskStringToDay } from './context'
import type { ObservedQueryRow } from '../types'
import type { ReportPollResult } from '../../src/lib/boris-direct/reports'

export type { ReportPollResult } from '../../src/lib/boris-direct/reports'

/** Как в реальном модуле: сервер не прислал retryIn → повтор через минуту. */
const DEFAULT_RETRY_IN_SEC = 60

// ---------- Разбор тела отчёта ----------

interface ParsedReportBody {
  reportType: string
  dateFrom: string
  dateTo: string
  fieldNames: string[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** Достаёт из body.params ReportType, диапазон дат и FieldNames — иначе громкая ошибка. */
function parseBody(body: unknown): ParsedReportBody {
  const params = asRecord(asRecord(body)?.params)
  const criteria = asRecord(params?.SelectionCriteria)
  const reportType = params?.ReportType
  const dateFrom = criteria?.DateFrom
  const dateTo = criteria?.DateTo
  const fieldNames = params?.FieldNames
  if (
    typeof reportType !== 'string' ||
    typeof dateFrom !== 'string' ||
    typeof dateTo !== 'string' ||
    !Array.isArray(fieldNames) ||
    fieldNames.some((f) => typeof f !== 'string')
  ) {
    throw new Error(
      `[sim/fakes/reports] unsupported query: тело отчёта без params.ReportType/SelectionCriteria.DateFrom/DateTo/FieldNames — ${JSON.stringify(body)?.slice(0, 200)}`
    )
  }
  return { reportType, dateFrom, dateTo, fieldNames: fieldNames as string[] }
}

// ---------- Агрегация наблюдаемых строк ----------

/** Строки поискового отчёта мира за диапазон дней — из ПОСЛЕДНЕГО наблюдаемого дня. */
function observedRowsInRange(fromDay: number, toDay: number): ObservedQueryRow[] {
  const ctx = getCtx()
  const latest = ctx.days[ctx.days.length - 1]
  if (!latest) return []
  return latest.queryRows.filter((r) => r.day >= fromDay && r.day <= toDay)
}

interface Agg {
  adGroupId: string
  adGroupName: string
  impressions: number
  clicks: number
  costRub: number
  conversions: number
}

function addTo(agg: Agg, row: ObservedQueryRow): void {
  agg.impressions += row.impressions
  agg.clicks += row.clicks
  agg.costRub += row.costRub
  agg.conversions += row.conversions
}

/** Деньги — 2 знака; Conversions: 0 → '--' (как в TSV Директа). */
const fmtCost = (rub: number): string => rub.toFixed(2)
const fmtConversions = (n: number): string => (n > 0 ? String(n) : '--')

/** Строка данных по порядку FieldNames; незнакомое поле — громкая ошибка. */
function buildLine(fieldNames: string[], values: Record<string, string>, reportType: string): string {
  return fieldNames
    .map((field) => {
      const v = values[field]
      if (v === undefined) {
        throw new Error(`[sim/fakes/reports] unsupported query: поле «${field}» в ${reportType} не поддержано`)
      }
      return v
    })
    .join('\t')
}

/** SEARCH_QUERY_PERFORMANCE_REPORT: агрегат за диапазон по (query, adGroupId). */
function buildSearchQueryTsv(fieldNames: string[], rows: ObservedQueryRow[]): string {
  const byKey = new Map<string, Agg & { query: string }>()
  for (const row of rows) {
    const key = `${row.adGroupId} ${row.query}`
    let agg = byKey.get(key)
    if (!agg) {
      agg = {
        query: row.query,
        adGroupId: row.adGroupId,
        adGroupName: row.adGroupName,
        impressions: 0,
        clicks: 0,
        costRub: 0,
        conversions: 0,
      }
      byKey.set(key, agg)
    }
    addTo(agg, row)
  }

  const lines = [...byKey.values()]
    .sort(
      (a, b) =>
        (a.adGroupId < b.adGroupId ? -1 : a.adGroupId > b.adGroupId ? 1 : 0) ||
        (a.query < b.query ? -1 : a.query > b.query ? 1 : 0)
    )
    .map((agg) =>
      buildLine(
        fieldNames,
        {
          Query: agg.query,
          AdGroupName: agg.adGroupName,
          AdGroupId: agg.adGroupId,
          Impressions: String(agg.impressions),
          Clicks: String(agg.clicks),
          Cost: fmtCost(agg.costRub),
          Conversions: fmtConversions(agg.conversions),
        },
        'SEARCH_QUERY_PERFORMANCE_REPORT'
      )
    )

  return [fieldNames.join('\t'), ...lines].join('\n') + '\n'
}

/** CUSTOM_REPORT (эффективность по дням): агрегат по (день, adGroupId). */
function buildCampaignPerformanceTsv(fieldNames: string[], rows: ObservedQueryRow[]): string {
  const byKey = new Map<string, Agg & { day: number }>()
  for (const row of rows) {
    const key = `${row.day} ${row.adGroupId}`
    let agg = byKey.get(key)
    if (!agg) {
      agg = {
        day: row.day,
        adGroupId: row.adGroupId,
        adGroupName: row.adGroupName,
        impressions: 0,
        clicks: 0,
        costRub: 0,
        conversions: 0,
      }
      byKey.set(key, agg)
    }
    addTo(agg, row)
  }

  const lines = [...byKey.values()]
    .sort(
      (a, b) =>
        a.day - b.day || (a.adGroupId < b.adGroupId ? -1 : a.adGroupId > b.adGroupId ? 1 : 0)
    )
    .map((agg) =>
      buildLine(
        fieldNames,
        {
          Date: dayToMskString(agg.day),
          AdGroupId: agg.adGroupId,
          AdGroupName: agg.adGroupName,
          Impressions: String(agg.impressions),
          Clicks: String(agg.clicks),
          // Как Директ: неопределённые метрики — '--' (tsvNumber мозга видит 0).
          Ctr: agg.impressions > 0 ? ((agg.clicks / agg.impressions) * 100).toFixed(2) : '--',
          Cost: fmtCost(agg.costRub),
          AvgCpc: agg.clicks > 0 ? (agg.costRub / agg.clicks).toFixed(2) : '--',
          Conversions: fmtConversions(agg.conversions),
        },
        'CUSTOM_REPORT'
      )
    )

  return [fieldNames.join('\t'), ...lines].join('\n') + '\n'
}

// ---------- Поллинг ----------

/**
 * Один шаг поллинга отчёта (подмена pollReport). Повтор с ТЕМ ЖЕ телом —
 * как в бою: тело хранится в BorisDirectReportJob.params и передаётся сюда.
 */
export async function fakePollReport(body: unknown): Promise<ReportPollResult> {
  const ctx = getCtx()
  const { reportType, dateFrom, dateTo, fieldNames } = parseBody(body)

  if (ctx.reportDelayPolls > 0) {
    ctx.reportDelayPolls -= 1
    return { status: 'pending', retryInSec: DEFAULT_RETRY_IN_SEC }
  }

  const rows = observedRowsInRange(mskStringToDay(dateFrom), mskStringToDay(dateTo))

  if (reportType === 'SEARCH_QUERY_PERFORMANCE_REPORT') {
    return { status: 'ready', tsv: buildSearchQueryTsv(fieldNames, rows) }
  }
  if (reportType === 'CUSTOM_REPORT') {
    return { status: 'ready', tsv: buildCampaignPerformanceTsv(fieldNames, rows) }
  }
  throw new Error(`[sim/fakes/reports] unsupported query: ReportType=${reportType}`)
}
