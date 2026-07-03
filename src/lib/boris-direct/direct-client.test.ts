import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Транспортный клиент API Директа v5. Сеть мокаем целиком
 * (vi.stubGlobal('fetch')) — ни одного живого вызова API.
 *
 * Проверяем: конверт result/error и DirectApiError (код/request_id, БЕЗ
 * токена), HTTP-ошибку, фильтрацию '---autotargeting', пагинацию по
 * LimitedBy, форму пишущих запросов (KeywordId/SearchBid, NegativeKeywords
 * на верхнем уровне Campaign) и extractWriteIssues (10140 → warning).
 */

import {
  directCall,
  DirectApiError,
  getCampaignState,
  getAddMetricaTagValue,
  getKeywords,
  getAutotargetingRecords,
  getKeywordBids,
  getAds,
  setKeywordBids,
  updateCampaignNegatives,
  restoreMetricaTag,
  suspendKeywords,
  suspendCampaign,
  updateDailyBudget,
  extractWriteIssues,
  type CampaignState,
} from './direct-client'
import { DIRECT_CAMPAIGN_ID, MICRO } from './config'

const TEST_TOKEN = 'test-token-a1b2c3d4e5f6g7h8'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Тело i-го fetch-вызова, распарсенное из JSON. */
function sentBody(callIndex = 0): { method: string; params: Record<string, unknown> } {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(String(init.body))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('YANDEX_DIRECT_TOKEN', TEST_TOKEN)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('directCall', () => {
  it('успех: POST на /json/v5/{service}, конверт {method, params}, возвращает result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { Campaigns: [] } }))

    const result = await directCall<{ Campaigns: unknown[] }>('campaigns', 'get', { a: 1 })

    expect(result).toEqual({ Campaigns: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.direct.yandex.com/json/v5/campaigns')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(headers['Accept-Language']).toBe('ru')
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(sentBody()).toEqual({ method: 'get', params: { a: 1 } })
  })

  it('ошибка API: кидает DirectApiError с code/detail/request_id, БЕЗ токена в тексте', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        error: {
          error_code: 54,
          error_string: 'Нет прав',
          error_detail: 'Нет прав на кампанию',
          request_id: 'req-777',
        },
      })
    )

    const promise = directCall('campaigns', 'update', {})
    await expect(promise).rejects.toBeInstanceOf(DirectApiError)

    const err = (await promise.catch((e: unknown) => e)) as DirectApiError
    expect(err.code).toBe(54)
    expect(err.detail).toBe('Нет прав на кампанию')
    expect(err.requestId).toBe('req-777')
    expect(err.message).toContain('54')
    expect(err.message).toContain('Нет прав')
    expect(err.message).toContain('req-777')
    expect(err.message).not.toContain(TEST_TOKEN)
  })

  it('HTTP-ошибка без JSON-тела: DirectApiError со статусом в code, без токена', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }))

    const err = (await directCall('keywords', 'get', {}).catch((e: unknown) => e)) as DirectApiError
    expect(err).toBeInstanceOf(DirectApiError)
    expect(err.code).toBe(502)
    expect(err.message).toContain('502')
    expect(err.message).not.toContain(TEST_TOKEN)
  })
})

describe('getCampaignState / getAddMetricaTagValue', () => {
  const campaign: CampaignState = {
    Id: DIRECT_CAMPAIGN_ID,
    Name: 'Будни — Поиск — Волна 1',
    State: 'ON',
    Status: 'ACCEPTED',
    StatusPayment: 'ALLOWED',
    Type: 'TEXT_CAMPAIGN',
    DailyBudget: { Amount: 3000 * MICRO, Mode: 'STANDARD' },
    TextCampaign: {
      BiddingStrategy: { Search: { BiddingStrategyType: 'HIGHEST_POSITION' } },
      CounterIds: { Items: [110272989] },
      Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'NO' }],
    },
  }

  it('запрашивает боевую кампанию и возвращает её объект', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: { Campaigns: [campaign] } }))

    const state = await getCampaignState()

    expect(state.Id).toBe(DIRECT_CAMPAIGN_ID)
    expect(state.DailyBudget?.Amount).toBe(3000 * MICRO)
    const { params } = sentBody()
    expect(params.SelectionCriteria).toEqual({ Ids: [DIRECT_CAMPAIGN_ID] })
    expect(params.TextCampaignFieldNames).toEqual(['BiddingStrategy', 'CounterIds', 'Settings'])
  })

  it('getAddMetricaTagValue достаёт значение из Settings', () => {
    expect(getAddMetricaTagValue(campaign)).toBe('NO')
    expect(
      getAddMetricaTagValue({
        ...campaign,
        TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'YES' }] },
      })
    ).toBe('YES')
    // Настройки нет вовсе → считаем NO
    expect(getAddMetricaTagValue({ ...campaign, TextCampaign: undefined })).toBe('NO')
  })
})

describe('getKeywords', () => {
  const realKeyword = {
    Id: 1,
    Keyword: 'доставка обедов в офис',
    AdGroupId: 10,
    State: 'ON',
    Status: 'ACCEPTED',
    Bid: 100 * MICRO,
  }
  const autotargeting = {
    Id: 2,
    Keyword: '---autotargeting',
    AdGroupId: 10,
    State: 'ON',
    Status: 'ACCEPTED',
  }

  it('фильтрует служебные записи автотаргета', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ result: { Keywords: [realKeyword, autotargeting] } })
    )

    const keywords = await getKeywords()

    expect(keywords).toEqual([realKeyword])
  })

  it('getAutotargetingRecords возвращает только записи автотаргета', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ result: { Keywords: [realKeyword, autotargeting] } })
    )

    expect(await getAutotargetingRecords()).toEqual([autotargeting])
  })

  it('пагинация: при LimitedBy продолжает с Offset=LimitedBy до конца', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ result: { Keywords: [realKeyword], LimitedBy: 10000 } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ result: { Keywords: [{ ...realKeyword, Id: 3 }] } })
      )

    const keywords = await getKeywords()

    expect(keywords.map((k) => k.Id)).toEqual([1, 3])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentBody(0).params.Page).toEqual({ Limit: 10000, Offset: 0 })
    expect(sentBody(1).params.Page).toEqual({ Limit: 10000, Offset: 10000 })
  })
})

describe('getKeywordBids', () => {
  it('запрашивает Bid/AuctionBids поискового среза и ходит по страницам', async () => {
    const bid = {
      KeywordId: 1,
      AdGroupId: 10,
      CampaignId: DIRECT_CAMPAIGN_ID,
      Search: {
        Bid: 100 * MICRO,
        AuctionBids: [{ TrafficVolume: 75, Bid: 120 * MICRO, Price: 90 * MICRO }],
      },
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: { KeywordBids: [bid], LimitedBy: 10000 } }))
      .mockResolvedValueOnce(
        jsonResponse({ result: { KeywordBids: [{ ...bid, KeywordId: 2 }] } })
      )

    const bids = await getKeywordBids()

    expect(bids.map((b) => b.KeywordId)).toEqual([1, 2])
    const { params } = sentBody(0)
    expect(params.SearchFieldNames).toEqual(['Bid', 'AuctionBids'])
    expect(sentBody(1).params.Page).toEqual({ Limit: 10000, Offset: 10000 })
  })
})

describe('write-транспорт: форма запросов', () => {
  beforeEach(() => {
    // Свежий Response на каждый вызов: тело читается только один раз
    fetchMock.mockImplementation(async () => jsonResponse({ result: {} }))
  })

  it('setKeywordBids: KeywordId/SearchBid в микроединицах', async () => {
    await setKeywordBids([{ keywordId: 42, searchBidMicro: 150 * MICRO }])

    expect(sentBody()).toEqual({
      method: 'set',
      params: { KeywordBids: [{ KeywordId: 42, SearchBid: 150 * MICRO }] },
    })
  })

  it('updateCampaignNegatives: NegativeKeywords на ВЕРХНЕМ уровне Campaign, не в TextCampaign', async () => {
    await updateCampaignNegatives(['бесплатно', 'рецепт'])

    const { method, params } = sentBody()
    expect(method).toBe('update')
    const campaigns = params.Campaigns as Array<Record<string, unknown>>
    expect(campaigns[0]).toEqual({
      Id: DIRECT_CAMPAIGN_ID,
      NegativeKeywords: { Items: ['бесплатно', 'рецепт'] },
    })
    expect(campaigns[0].TextCampaign).toBeUndefined()
  })

  it('restoreMetricaTag: возвращает ADD_METRICA_TAG=YES через TextCampaign.Settings', async () => {
    await restoreMetricaTag()

    expect(sentBody().params.Campaigns).toEqual([
      {
        Id: DIRECT_CAMPAIGN_ID,
        TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'YES' }] },
      },
    ])
  })

  it('suspendKeywords / suspendCampaign: SelectionCriteria.Ids', async () => {
    await suspendKeywords([1, 2, 3])
    expect(sentBody(0)).toEqual({
      method: 'suspend',
      params: { SelectionCriteria: { Ids: [1, 2, 3] } },
    })

    await suspendCampaign()
    expect(sentBody(1)).toEqual({
      method: 'suspend',
      params: { SelectionCriteria: { Ids: [DIRECT_CAMPAIGN_ID] } },
    })
  })

  it('updateDailyBudget: Amount в микроединицах, Mode STANDARD', async () => {
    await updateDailyBudget(3000 * MICRO)

    expect(sentBody().params.Campaigns).toEqual([
      { Id: DIRECT_CAMPAIGN_ID, DailyBudget: { Amount: 3000 * MICRO, Mode: 'STANDARD' } },
    ])
  })
})

describe('extractWriteIssues', () => {
  it('раскладывает Errors/Warnings из поэлементных массивов результата', () => {
    const issues = extractWriteIssues({
      UpdateResults: [
        { Warnings: [{ Code: 10161, Message: 'Ставка скорректирована' }] },
        { Errors: [{ Code: 5005, Message: 'Неверный параметр', Details: 'SearchBid' }] },
      ],
    })

    expect(issues.errors).toEqual(['5005: Неверный параметр — SearchBid'])
    expect(issues.warnings).toEqual(['10161: Ставка скорректирована'])
  })

  it('код 10140 (дубль ключа) — warning, не ошибка, даже если пришёл в Errors', () => {
    const issues = extractWriteIssues({
      SetResults: [{ Errors: [{ Code: 10140, Message: 'Дублирующаяся фраза' }] }],
    })

    expect(issues.errors).toEqual([])
    expect(issues.warnings).toEqual(['10140: Дублирующаяся фраза'])
  })

  it('пустой/чужой результат → пустые списки', () => {
    expect(extractWriteIssues(undefined)).toEqual({ errors: [], warnings: [] })
    expect(extractWriteIssues({ AddResults: [{}] })).toEqual({ errors: [], warnings: [] })
  })
})
