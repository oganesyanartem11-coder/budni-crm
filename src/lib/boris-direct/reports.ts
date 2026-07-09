// Отчёты API Яндекс.Директа v5 (/json/v5/reports) роли «трафик» (Борис-Директ).
//
// В отличие от остальных сервисов v5, ответ отчётов — TSV, НЕ JSON.
// Отчёт «готовится» асинхронно: поллинг повторяет ТОТ ЖЕ POST с тем же телом
// (поэтому тело отчёта хранит вызывающий код, например в БД). Готовящийся
// отчёт держится на сервере до 5 часов.
//
// Токен берётся из env-читателя и НИКОГДА не логируется и не попадает
// в сообщения об ошибках.

import { readYandexDirectToken } from './env'
import { DIRECT_CAMPAIGN_ID, METRIKA_GOAL_ID } from './config'

const REPORTS_URL = 'https://api.direct.yandex.com/json/v5/reports'

/** Если сервер не прислал retryIn — спрашиваем снова через минуту. */
const DEFAULT_RETRY_IN_SEC = 60

/** Общий фильтр всех отчётов: только боевая кампания. */
function campaignFilter() {
  return [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(DIRECT_CAMPAIGN_ID)] }]
}

/**
 * Тело отчёта по поисковым запросам (SEARCH_QUERY_PERFORMANCE_REPORT).
 *
 * КРИТИЧНО: DateFrom/DateTo лежат ВНУТРИ SelectionCriteria (не на верхнем
 * уровне params) — иначе Директ отвечает ошибкой валидации.
 * Goals — id цели Метрики СТРОКОЙ в массиве.
 *
 * Уникальность reportName обеспечивает вызывающий код (метка времени).
 */
export function buildSearchQueryReportBody(
  dateFrom: string,
  dateTo: string,
  reportName: string
): unknown {
  return {
    params: {
      SelectionCriteria: {
        DateFrom: dateFrom,
        DateTo: dateTo,
        Filter: campaignFilter(),
      },
      Goals: [String(METRIKA_GOAL_ID)],
      // CriterionId — id ключа, на который Директ сматчил запрос (broad match):
      // экономика агрегируется по нему, а не по тексту запроса. Поле выверено
      // живым зондом SQ-отчёта (принято, совпадает с Id из keywords.get).
      FieldNames: ['Query', 'AdGroupName', 'AdGroupId', 'CriterionId', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
      ReportName: reportName,
      ReportType: 'SEARCH_QUERY_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
    },
  }
}

/**
 * Тело отчёта эффективности кампании в разрезе групп по дням (CUSTOM_REPORT).
 *
 * Те же правила, что и у buildSearchQueryReportBody: CUSTOM_DATE внутри
 * SelectionCriteria, фильтр по CampaignId, Goals строкой.
 */
export function buildCampaignPerformanceReportBody(
  dateFrom: string,
  dateTo: string,
  reportName: string
): unknown {
  return {
    params: {
      SelectionCriteria: {
        DateFrom: dateFrom,
        DateTo: dateTo,
        Filter: campaignFilter(),
      },
      Goals: [String(METRIKA_GOAL_ID)],
      FieldNames: [
        'Date',
        'AdGroupId',
        'AdGroupName',
        'Impressions',
        'Clicks',
        'Ctr',
        'Cost',
        'AvgCpc',
        'Conversions',
      ],
      ReportName: reportName,
      ReportType: 'CUSTOM_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
    },
  }
}

/**
 * Тело отчёта расхода по УСТРОЙСТВАМ (сессия «Прозрение»): точный источник
 * денег для DEVICE_SKEW (Метрика даёт визиты, а тут — Cost/Clicks/Conversions
 * по desktop/mobile/tablet). Поле `Device` выверено боевой пробой кабинета.
 * Те же правила, что у остальных тел: даты внутри SelectionCriteria, Goals
 * строкой. Транспорт добавлен; в дневной цикл пока НЕ подключён (диагноз
 * DEVICE_SKEW сейчас питается срезом Метрики) — доступен для точечного расчёта.
 */
export function buildDeviceReportBody(
  dateFrom: string,
  dateTo: string,
  reportName: string
): unknown {
  return {
    params: {
      SelectionCriteria: {
        DateFrom: dateFrom,
        DateTo: dateTo,
        Filter: campaignFilter(),
      },
      Goals: [String(METRIKA_GOAL_ID)],
      FieldNames: ['Device', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
      ReportName: reportName,
      ReportType: 'CUSTOM_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
    },
  }
}

export type ReportPollResult =
  | { status: 'ready'; tsv: string }
  | { status: 'pending'; retryInSec: number }
  | { status: 'failed'; error: string }

/**
 * Один шаг поллинга отчёта: ОДИН POST с телом отчёта.
 *
 * - HTTP 200 → отчёт готов, тело — TSV;
 * - HTTP 201/202 → отчёт готовится, повторить ТОТ ЖЕ POST через retryIn секунд
 *   (заголовок retryIn; если его нет — DEFAULT_RETRY_IN_SEC);
 * - иначе → failed с разбором JSON-ошибки тела (error_string/error_detail,
 *   токен в текст не попадает).
 */
export async function pollReport(body: unknown): Promise<ReportPollResult> {
  const token = readYandexDirectToken()

  const res = await fetch(REPORTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Language': 'ru',
      'Content-Type': 'application/json; charset=utf-8',
      processingMode: 'auto',
      returnMoneyInMicros: 'false',
      skipReportHeader: 'true',
      skipColumnHeader: 'false',
      skipReportSummary: 'true',
    },
    body: JSON.stringify(body),
  })

  if (res.status === 200) {
    return { status: 'ready', tsv: await res.text() }
  }

  if (res.status === 201 || res.status === 202) {
    const retryIn = Number(res.headers.get('retryIn'))
    return {
      status: 'pending',
      retryInSec: Number.isFinite(retryIn) && retryIn > 0 ? retryIn : DEFAULT_RETRY_IN_SEC,
    }
  }

  // Ошибка: тело — JSON с { error: { error_code, error_string, error_detail, request_id } }
  const text = await res.text()
  let error = `HTTP ${res.status}`
  try {
    const parsed = JSON.parse(text) as {
      error?: { error_code?: number; error_string?: string; error_detail?: string; request_id?: string }
    }
    if (parsed.error) {
      const e = parsed.error
      error =
        `HTTP ${res.status}: code=${e.error_code ?? '?'} ${e.error_string ?? ''}` +
        (e.error_detail ? ` — ${e.error_detail}` : '') +
        (e.request_id ? ` (request_id=${e.request_id})` : '')
    }
  } catch {
    // тело не JSON — оставляем голый HTTP-статус, содержимое не светим
  }
  return { status: 'failed', error }
}

/**
 * Разбор TSV-отчёта: первая строка — имена колонок (skipColumnHeader: false),
 * остальные — данные, разделитель \t. Пустые строки пропускаются.
 * Числа НЕ конвертируются — все значения строками, это забота вызывающего кода.
 */
export function parseReportTsv(tsv: string): Array<Record<string, string>> {
  const lines = tsv
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) return []

  const columns = lines[0].split('\t')
  return lines.slice(1).map((line) => {
    const cells = line.split('\t')
    const row: Record<string, string> = {}
    columns.forEach((column, i) => {
      row[column] = cells[i] ?? ''
    })
    return row
  })
}
