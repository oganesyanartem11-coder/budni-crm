// Клиент API Яндекс.Метрики для роли «трафик» (Борис-Директ).
//
// ЖЁСТКИЕ ИНВАРИАНТЫ:
// - заголовок авторизации: Authorization: OAuth <токен> (именно OAuth, НЕ Bearer!);
// - токен НИКОГДА не логировать и не включать в тексты ошибок;
// - только чтение (/stat/v1/data); офлайн-конверсии — задел, НЕ вызывать
//   до активации владельцем (см. JSDoc uploadOfflineConversions).

import { readYandexMetricaToken } from './env'
import { METRIKA_COUNTER_ID, METRIKA_GOAL_ID, MSK_TIMEZONE_PARAM } from './config'

const METRIKA_API_BASE = 'https://api-metrika.yandex.net'

/** Метрика достижений цели «Заявка» — стержень всех срезов. */
const GOAL_REACHES_METRIC = `ym:s:goal${METRIKA_GOAL_ID}reaches`

// ---------- Ошибки ----------

/** Ошибка API Метрики: HTTP-статус + детали из тела ответа (без токена). */
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

/**
 * Достаём человекочитаемые детали из тела ошибки Метрики
 * ({ errors: [{ message }], message }). Токена в теле нет — в детали
 * попадает только текст самой Метрики.
 */
async function parseMetrikaErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as {
      message?: string
      errors?: Array<{ message?: string }>
    }
    const fromErrors = body.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join('; ')
    return body.message ?? (fromErrors || undefined)
  } catch {
    // Тело не JSON — деталей нет, статус скажет достаточно.
    return undefined
  }
}

// ---------- Отчёты (/stat/v1/data) ----------

/** Строка отчёта Метрики: измерения + числовые метрики в порядке запроса. */
export interface MetrikaStatRow {
  dimensions: Array<{ name: string | null }>
  metrics: number[]
}

/** Ответ /stat/v1/data (интересующая нас часть). */
export interface MetrikaStatResponse {
  data: MetrikaStatRow[]
  totals?: number[]
}

/**
 * GET /stat/v1/data. ids счётчика подставляется сам из METRIKA_COUNTER_ID.
 * Остальные параметры (metrics, dimensions, date1, date2, filters, limit…)
 * передаются как есть.
 */
export async function metrikaStat(params: Record<string, string>): Promise<MetrikaStatResponse> {
  const token = readYandexMetricaToken()
  const search = new URLSearchParams({ ids: String(METRIKA_COUNTER_ID), ...params })

  const res = await fetch(`${METRIKA_API_BASE}/stat/v1/data?${search.toString()}`, {
    headers: {
      // Именно OAuth — Метрика не принимает Bearer.
      Authorization: `OAuth ${token}`,
    },
  })

  if (!res.ok) {
    throw new MetrikaApiError(res.status, await parseMetrikaErrorDetail(res))
  }

  return (await res.json()) as MetrikaStatResponse
}

// ---------- Готовые срезы под цель «Заявка» ----------

/** Визиты и заявки по дням — базовый пульс кампании. */
export async function getGoalStatsByDay(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ date: string; visits: number; goalReaches: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:date',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
  })
  return resp.data.map((row) => ({
    date: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
  }))
}

/** Источники трафика: визиты, заявки, отказы — где конвертит, а где сливается. */
export async function getGoalStatsBySource(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ source: string; visits: number; goalReaches: number; bounceRate: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:lastTrafficSource',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC},ym:s:bounceRate`,
    date1: dateFrom,
    date2: dateTo,
  })
  return resp.data.map((row) => ({
    source: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
    bounceRate: row.metrics[2] ?? 0,
  }))
}

/** Срез по UTM-меткам — связка с кампаниями и фразами Директа. */
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
  const resp = await metrikaStat({
    dimensions: 'ym:s:UTMSource,ym:s:UTMCampaign,ym:s:UTMTerm',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
    limit: '1000',
  })
  return resp.data.map((row) => ({
    utmSource: row.dimensions[0]?.name ?? '',
    utmCampaign: row.dimensions[1]?.name ?? '',
    utmTerm: row.dimensions[2]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
  }))
}

/** Страницы входа: куда приземляются и где оставляют заявки. */
export async function getGoalStatsByLandingPage(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ path: string; visits: number; goalReaches: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:startURLPath',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
  })
  return resp.data.map((row) => ({
    path: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
  }))
}

// ---------- Разведочные срезы (сессия «Прозрение»): устройства/демография/
// час — питают диагнозы DEVICE_SKEW / AUDIENCE_WASTE / SCHEDULE_WASTE.
// Изолируем рекламный трафик (Директ) фильтром ym:s:lastTrafficSource=='ad'. ----------

/** Только рекламный трафик — чтобы срез был про Директ, а не про весь сайт. */
const AD_TRAFFIC_FILTER = "ym:s:lastTrafficSource=='ad'"

/** Заявки/визиты/отказы по типу устройства (desktop/mobile/tablet). */
export async function getGoalStatsByDevice(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:deviceCategory',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC},ym:s:bounceRate`,
    date1: dateFrom,
    date2: dateTo,
    filters: AD_TRAFFIC_FILTER,
  })
  return resp.data.map((row) => ({
    device: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
    bounceRate: row.metrics[2] ?? 0,
  }))
}

/** Заявки/визиты по полу И возрасту — сырьё для AUDIENCE_WASTE. */
export async function getGoalStatsByDemographics(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ gender: string; age: string; visits: number; goalReaches: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:gender,ym:s:ageInterval',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
    filters: AD_TRAFFIC_FILTER,
    limit: '100',
  })
  return resp.data.map((row) => ({
    gender: row.dimensions[0]?.name ?? '',
    age: row.dimensions[1]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
  }))
}

/**
 * Рекламные визиты по ПОИСКОВОЙ ФРАЗЕ Директа × ЧАСУ за день (спринт 16.07: подсказка
 * «с какого запроса пришёл звонок» по времени). Фильтр 'ad' = наша кампания (одна в
 * аккаунте; при Волне 2 нужна изоляция по кампании). Час — в МСК: пинуем timezone=+03:00
 * (счётчик и так МСК, но пин снимает зависимость от настройки — час совпадает со
 * временем звонка). ТОЛЬКО чтение (/stat/v1/data), OAuth. Это ГИПОТЕЗА по времени, не
 * атрибуция (визит↔звонок по времени не доказуем).
 */
export async function getAdVisitsByPhraseHour(
  day: string
): Promise<Array<{ phrase: string; hour: number; visits: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:lastDirectSearchPhrase,ym:s:hour',
    metrics: 'ym:s:visits',
    date1: day,
    date2: day,
    filters: AD_TRAFFIC_FILTER,
    limit: '1000',
    timezone: MSK_TIMEZONE_PARAM,
  })
  return resp.data.map((row) => ({
    phrase: row.dimensions[0]?.name ?? '',
    hour: Number(row.dimensions[1]?.name ?? -1),
    visits: row.metrics[0] ?? 0,
  }))
}

/** Заявки/визиты по часу суток (0..23) — вторичный сигнал мёртвых часов. */
export async function getGoalStatsByHour(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ hour: string; visits: number; goalReaches: number }>> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:hour',
    metrics: `ym:s:visits,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
    filters: AD_TRAFFIC_FILTER,
    limit: '48',
  })
  return resp.data.map((row) => ({
    hour: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    goalReaches: row.metrics[1] ?? 0,
  }))
}

/**
 * Пофразное ПОВЕДЕНИЕ рекламного трафика по поисковой фразе Директа
 * (lastDirectSearchPhrase): визиты, отказы (%), средняя длительность (сек),
 * заявки. Изолируем рекламу фильтром 'ad'. Питает поведенческие минус-кандидаты
 * (ТОЛЬКО предложением): фраза с трафиком, но 100%-отказом / мгновенным уходом и
 * нулём заявок видна по поведению задолго до порога показов. Выверено зондом:
 * 'доставка обедов по клину' → 2 визита, 50% отказ, 8 сек, 0 целей.
 */
export async function getGoalStatsByPhrase(
  dateFrom: string,
  dateTo: string
): Promise<
  Array<{ phrase: string; visits: number; bounceRate: number; avgDurationSec: number; goalReaches: number }>
> {
  const resp = await metrikaStat({
    dimensions: 'ym:s:lastDirectSearchPhrase',
    metrics: `ym:s:visits,ym:s:bounceRate,ym:s:avgVisitDurationSeconds,${GOAL_REACHES_METRIC}`,
    date1: dateFrom,
    date2: dateTo,
    filters: AD_TRAFFIC_FILTER,
    limit: '1000',
  })
  return resp.data.map((row) => ({
    phrase: row.dimensions[0]?.name ?? '',
    visits: row.metrics[0] ?? 0,
    bounceRate: row.metrics[1] ?? 0,
    avgDurationSec: row.metrics[2] ?? 0,
    goalReaches: row.metrics[3] ?? 0,
  }))
}

// ---------- Офлайн-конверсии (задел — активируем, когда пойдут сделки) ----------

/** Строка офлайн-конверсии: идентификатор клика/визита + цель + момент. */
export interface OfflineConversionRow {
  yclid?: string
  clientId?: string
  target: string
  dateTime: Date
  price?: number
  currency?: string
}

/**
 * Собирает CSV для загрузки офлайн-конверсий. DateTime — unix-СЕКУНДЫ.
 * В заголовок попадают только реально заполненные колонки: Yclid и/или
 * ClientId (что есть в данных), Target и DateTime всегда, Price/Currency —
 * если заданы хоть в одной строке.
 */
export function buildOfflineConversionsCsv(rows: OfflineConversionRow[]): string {
  const hasYclid = rows.some((r) => r.yclid)
  const hasClientId = rows.some((r) => r.clientId)
  const hasPrice = rows.some((r) => r.price !== undefined)
  const hasCurrency = rows.some((r) => r.currency)

  const header = [
    ...(hasYclid ? ['Yclid'] : []),
    ...(hasClientId ? ['ClientId'] : []),
    'Target',
    'DateTime',
    ...(hasPrice ? ['Price'] : []),
    ...(hasCurrency ? ['Currency'] : []),
  ]

  const lines = rows.map((r) =>
    [
      ...(hasYclid ? [r.yclid ?? ''] : []),
      ...(hasClientId ? [r.clientId ?? ''] : []),
      r.target,
      String(Math.floor(r.dateTime.getTime() / 1000)),
      ...(hasPrice ? [r.price !== undefined ? String(r.price) : ''] : []),
      ...(hasCurrency ? [r.currency ?? ''] : []),
    ].join(',')
  )

  return [header.join(','), ...lines].join('\n')
}

/**
 * POST /management/v1/counter/<id>/offline_conversions/upload (multipart, file).
 *
 * НЕ ВЫЗЫВАТЬ, пока владелец не активирует: нужен токен со scope
 * metrika:write и включённое офлайн-отслеживание на счётчике. Сейчас это
 * задел — структура готова, данные сделок ещё не идут.
 */
export async function uploadOfflineConversions(csv: string): Promise<unknown> {
  const token = readYandexMetricaToken()

  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'conversions.csv')

  const res = await fetch(
    `${METRIKA_API_BASE}/management/v1/counter/${METRIKA_COUNTER_ID}/offline_conversions/upload`,
    {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}` },
      body: form,
    }
  )

  if (!res.ok) {
    throw new MetrikaApiError(res.status, await parseMetrikaErrorDetail(res))
  }

  return await res.json()
}
