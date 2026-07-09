import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Отчёты Директа (/json/v5/reports). Сеть мокаем целиком
 * (vi.stubGlobal('fetch')) — ни одного живого вызова API.
 *
 * Проверяем: тела отчётов (DateFrom/DateTo ВНУТРИ SelectionCriteria, фильтр
 * по CampaignId, Goals строкой), pollReport (200 → ready, 201/202 → pending
 * с retryIn, иначе failed без токена) и parseReportTsv.
 */

import {
  buildSearchQueryReportBody,
  buildCampaignPerformanceReportBody,
  buildTodaySpendReportBody,
  pollReport,
  parseReportTsv,
} from './reports'
import { DIRECT_CAMPAIGN_ID, METRIKA_GOAL_ID } from './config'

const TEST_TOKEN = 'test-token-a1b2c3d4e5f6g7h8'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('YANDEX_DIRECT_TOKEN', TEST_TOKEN)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type ReportParams = {
  SelectionCriteria: { DateFrom?: string; DateTo?: string; Filter?: unknown[] }
  [key: string]: unknown
}

describe('buildSearchQueryReportBody', () => {
  const body = buildSearchQueryReportBody('2026-06-01', '2026-06-30', 'sq-report-123') as {
    params: ReportParams
  }

  it('DateFrom/DateTo лежат ВНУТРИ SelectionCriteria, не на верхнем уровне params', () => {
    expect(body.params.SelectionCriteria.DateFrom).toBe('2026-06-01')
    expect(body.params.SelectionCriteria.DateTo).toBe('2026-06-30')
    expect(body.params.DateFrom).toBeUndefined()
    expect(body.params.DateTo).toBeUndefined()
    expect(body.params.DateRangeType).toBe('CUSTOM_DATE')
  })

  it('обязателен фильтр по CampaignId (значения строками)', () => {
    expect(body.params.SelectionCriteria.Filter).toEqual([
      { Field: 'CampaignId', Operator: 'EQUALS', Values: [String(DIRECT_CAMPAIGN_ID)] },
    ])
  })

  it('Goals — id цели Метрики строкой в массиве', () => {
    expect(body.params.Goals).toEqual([String(METRIKA_GOAL_ID)])
    expect(body.params.Goals).toEqual(['575665118'])
  })

  it('тип/формат/имя отчёта', () => {
    expect(body.params.ReportType).toBe('SEARCH_QUERY_PERFORMANCE_REPORT')
    expect(body.params.ReportName).toBe('sq-report-123')
    expect(body.params.Format).toBe('TSV')
    expect(body.params.IncludeVAT).toBe('YES')
    expect(body.params.FieldNames).toEqual([
      'Query',
      'AdGroupName',
      'AdGroupId',
      'CriterionId',
      'Impressions',
      'Clicks',
      'Cost',
      'Conversions',
    ])
  })
})

describe('buildTodaySpendReportBody (интрадей-расход)', () => {
  it('DateRangeType=TODAY, БЕЗ DateFrom/DateTo, фильтр кампании, поля Date/Clicks/Cost', () => {
    const body = buildTodaySpendReportBody('today-spend-1') as { params: ReportParams }

    expect(body.params.ReportType).toBe('CUSTOM_REPORT')
    expect(body.params.DateRangeType).toBe('TODAY')
    // TODAY-диапазон НЕ допускает DateFrom/DateTo в SelectionCriteria.
    expect(body.params.SelectionCriteria.DateFrom).toBeUndefined()
    expect(body.params.SelectionCriteria.DateTo).toBeUndefined()
    expect(body.params.SelectionCriteria.Filter).toEqual([
      { Field: 'CampaignId', Operator: 'EQUALS', Values: [String(DIRECT_CAMPAIGN_ID)] },
    ])
    expect(body.params.FieldNames).toEqual(['Date', 'Clicks', 'Cost'])
    expect(body.params.ReportName).toBe('today-spend-1')
    expect(body.params.Format).toBe('TSV')
  })
})

describe('buildCampaignPerformanceReportBody', () => {
  it('CUSTOM_REPORT по группам: тот же фильтр, даты внутри SelectionCriteria', () => {
    const body = buildCampaignPerformanceReportBody('2026-06-01', '2026-06-30', 'perf-1') as {
      params: ReportParams
    }

    expect(body.params.ReportType).toBe('CUSTOM_REPORT')
    expect(body.params.DateRangeType).toBe('CUSTOM_DATE')
    expect(body.params.SelectionCriteria.DateFrom).toBe('2026-06-01')
    expect(body.params.SelectionCriteria.Filter).toEqual([
      { Field: 'CampaignId', Operator: 'EQUALS', Values: [String(DIRECT_CAMPAIGN_ID)] },
    ])
    expect(body.params.Goals).toEqual([String(METRIKA_GOAL_ID)])
    expect(body.params.FieldNames).toEqual([
      'Date',
      'AdGroupId',
      'AdGroupName',
      'Impressions',
      'Clicks',
      'Ctr',
      'Cost',
      'AvgCpc',
      'Conversions',
    ])
  })
})

describe('pollReport', () => {
  const body = buildSearchQueryReportBody('2026-06-01', '2026-06-30', 'sq-1')

  it('HTTP 200 → ready с TSV-текстом; заголовки отчётного сервиса на месте', async () => {
    const tsv = 'Query\tClicks\nобеды в офис\t5\n'
    fetchMock.mockResolvedValue(new Response(tsv, { status: 200 }))

    const result = await pollReport(body)

    expect(result).toEqual({ status: 'ready', tsv })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.direct.yandex.com/json/v5/reports')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers.processingMode).toBe('auto')
    expect(headers.returnMoneyInMicros).toBe('false')
    expect(headers.skipReportHeader).toBe('true')
    expect(headers.skipColumnHeader).toBe('false')
    expect(headers.skipReportSummary).toBe('true')
    expect(JSON.parse(String(init.body))).toEqual(body)
  })

  it('HTTP 202 с retryIn → pending с retryInSec из заголовка', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 202, headers: { retryIn: '30' } })
    )

    expect(await pollReport(body)).toEqual({ status: 'pending', retryInSec: 30 })
  })

  it('HTTP 201 без retryIn → pending с дефолтом 60', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }))

    expect(await pollReport(body)).toEqual({ status: 'pending', retryInSec: 60 })
  })

  it('HTTP 400 с JSON-ошибкой → failed с error_string/error_detail, БЕЗ токена', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            error_code: 5001,
            error_string: 'Некорректный отчёт',
            error_detail: 'DateFrom вне SelectionCriteria',
            request_id: 'req-42',
          },
        }),
        { status: 400 }
      )
    )

    const result = await pollReport(body)

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('unreachable')
    expect(result.error).toContain('5001')
    expect(result.error).toContain('Некорректный отчёт')
    expect(result.error).toContain('DateFrom вне SelectionCriteria')
    expect(result.error).toContain('req-42')
    expect(result.error).not.toContain(TEST_TOKEN)
  })

  it('HTTP 500 с не-JSON телом → failed с голым HTTP-статусом', async () => {
    fetchMock.mockResolvedValue(new Response('Internal error', { status: 500 }))

    expect(await pollReport(body)).toEqual({ status: 'failed', error: 'HTTP 500' })
  })
})

describe('parseReportTsv', () => {
  it('первая строка — имена колонок, остальные — данные', () => {
    const tsv = 'Query\tClicks\tCost\nобеды в офис\t5\t1200.50\nдоставка обедов\t3\t800.00\n'

    expect(parseReportTsv(tsv)).toEqual([
      { Query: 'обеды в офис', Clicks: '5', Cost: '1200.50' },
      { Query: 'доставка обедов', Clicks: '3', Cost: '800.00' },
    ])
  })

  it('пустые строки пропускаются, числа остаются строками', () => {
    const tsv = 'Query\tClicks\n\nобеды\t7\n\n'
    const rows = parseReportTsv(tsv)

    expect(rows).toEqual([{ Query: 'обеды', Clicks: '7' }])
    expect(typeof rows[0].Clicks).toBe('string')
  })

  it('недостающие ячейки → пустая строка; \\r\\n переносы поддержаны', () => {
    const tsv = 'Query\tClicks\tCost\r\nобеды\t7\r\n'

    expect(parseReportTsv(tsv)).toEqual([{ Query: 'обеды', Clicks: '7', Cost: '' }])
  })

  it('пустой ввод → пустой массив', () => {
    expect(parseReportTsv('')).toEqual([])
    expect(parseReportTsv('\n\n')).toEqual([])
  })
})
