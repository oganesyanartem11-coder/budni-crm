import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Клиент Метрики: без сети (fetch через vi.stubGlobal) и без ENV-утечек
 * (vi.stubEnv). Главные инварианты: заголовок именно 'OAuth <токен>'
 * (НЕ Bearer) и токен никогда не попадает в тексты ошибок.
 */

import {
  MetrikaApiError,
  metrikaStat,
  getGoalStatsByDay,
  buildOfflineConversionsCsv,
  uploadOfflineConversions,
} from './metrika-client'
import { METRIKA_COUNTER_ID, METRIKA_GOAL_ID } from './config'

const TOKEN = 'test-metrika-oauth-token-123456'

const mockFetch = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubEnv('YANDEX_METRICA_TOKEN', TOKEN)
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('metrikaStat', () => {
  it('успех: GET /stat/v1/data, ids подставлен, параметры в query, JSON возвращён', async () => {
    const payload = { data: [], totals: [0] }
    mockFetch.mockResolvedValue(jsonResponse(payload))

    const result = await metrikaStat({ metrics: 'ym:s:visits', date1: '2026-06-01', date2: '2026-06-30' })

    expect(result).toEqual(payload)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.origin).toBe('https://api-metrika.yandex.net')
    expect(url.pathname).toBe('/stat/v1/data')
    expect(url.searchParams.get('ids')).toBe(String(METRIKA_COUNTER_ID))
    expect(url.searchParams.get('metrics')).toBe('ym:s:visits')
    expect(url.searchParams.get('date1')).toBe('2026-06-01')
  })

  it("заголовок авторизации — именно 'OAuth <токен>', не Bearer", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))

    await metrikaStat({ metrics: 'ym:s:visits' })

    const init = mockFetch.mock.calls[0][1] as RequestInit
    const auth = (init.headers as Record<string, string>).Authorization
    expect(auth).toBe(`OAuth ${TOKEN}`)
    expect(auth.startsWith('Bearer')).toBe(false)
  })

  it('ошибка API: MetrikaApiError со статусом и деталями, БЕЗ токена в сообщении', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: 'Invalid parameter' }], message: 'Wrong metrics' }, 400)
    )

    const err = await metrikaStat({ metrics: 'oops' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MetrikaApiError)
    const apiErr = err as MetrikaApiError
    expect(apiErr.status).toBe(400)
    expect(apiErr.detail).toBe('Wrong metrics')
    expect(apiErr.message).not.toContain(TOKEN)
  })

  it('ошибка с не-JSON телом: статус есть, деталей нет, токена нет', async () => {
    mockFetch.mockResolvedValue(new Response('<html>503</html>', { status: 503 }))

    const err = await metrikaStat({ metrics: 'ym:s:visits' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MetrikaApiError)
    expect((err as MetrikaApiError).status).toBe(503)
    expect((err as MetrikaApiError).detail).toBeUndefined()
    expect((err as MetrikaApiError).message).not.toContain(TOKEN)
  })
})

describe('getGoalStatsByDay', () => {
  it('парсит строки отчёта в { date, visits, goalReaches } и шлёт goal-метрику из config', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [
          { dimensions: [{ name: '2026-06-01' }], metrics: [120, 3] },
          { dimensions: [{ name: '2026-06-02' }], metrics: [95, 0] },
        ],
        totals: [215, 3],
      })
    )

    const rows = await getGoalStatsByDay('2026-06-01', '2026-06-02')

    expect(rows).toEqual([
      { date: '2026-06-01', visits: 120, goalReaches: 3 },
      { date: '2026-06-02', visits: 95, goalReaches: 0 },
    ])
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.searchParams.get('dimensions')).toBe('ym:s:date')
    expect(url.searchParams.get('metrics')).toBe(`ym:s:visits,ym:s:goal${METRIKA_GOAL_ID}reaches`)
  })
})

describe('buildOfflineConversionsCsv', () => {
  it('DateTime — unix-СЕКУНДЫ, Yclid+Target+DateTime без пустых колонок', () => {
    const dateTime = new Date('2026-06-15T10:00:00.000Z') // 1781431200 сек

    const csv = buildOfflineConversionsCsv([
      { yclid: '9876543210', target: 'lead', dateTime },
    ])

    expect(csv).toBe(
      'Yclid,Target,DateTime\n' + `9876543210,lead,${Math.floor(dateTime.getTime() / 1000)}`
    )
    // Миллисекунд в CSV быть не должно.
    expect(csv).not.toContain(String(dateTime.getTime()))
  })

  it('Price/Currency и ClientId появляются только когда заполнены хоть где-то', () => {
    const dateTime = new Date(1_750_000_000_000)

    const csv = buildOfflineConversionsCsv([
      { yclid: 'y1', target: 'lead', dateTime, price: 45000, currency: 'RUB' },
      { clientId: 'c2', target: 'lead', dateTime },
    ])

    const [header, row1, row2] = csv.split('\n')
    expect(header).toBe('Yclid,ClientId,Target,DateTime,Price,Currency')
    expect(row1).toBe('y1,,lead,1750000000,45000,RUB')
    expect(row2).toBe(',c2,lead,1750000000,,')
  })
})

describe('uploadOfflineConversions', () => {
  it('POST на management-эндпоинт счётчика с OAuth-заголовком и multipart-телом', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ uploading: { id: 1 } }))

    await uploadOfflineConversions('Yclid,Target,DateTime\ny1,lead,1750000000')

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `https://api-metrika.yandex.net/management/v1/counter/${METRIKA_COUNTER_ID}/offline_conversions/upload`
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe(`OAuth ${TOKEN}`)
    expect(init.body).toBeInstanceOf(FormData)
  })
})
