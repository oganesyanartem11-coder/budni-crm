// Транспортный клиент API Яндекс.Директа v5 (JSON) роли «трафик» (Борис-Директ).
//
// Это ТУПОЙ транспорт: он не знает про режимы (observe/write) и права.
// Решение «можно ли писать» принимает write-gate (src/lib/boris-direct/write-gate.ts) —
// все пишущие функции ниже вызываются ТОЛЬКО через него.
//
// Токен берётся из env-читателя и НИКОГДА не логируется и не попадает
// в сообщения об ошибках.

import { readYandexDirectToken } from './env'
import { DIRECT_CAMPAIGN_ID } from './config'

const DIRECT_API_BASE = 'https://api.direct.yandex.com/json/v5'

/** Лимит страницы пагинации Директа (максимум API). */
const PAGE_LIMIT = 10000

/** Служебная запись автотаргета в keywords.get — не настоящий ключ. */
const AUTOTARGETING_KEYWORD = '---autotargeting'

/** Код Директа «дубль ключевой фразы» — Яндекс схлопывает сам, это warning. */
const DUPLICATE_KEYWORD_CODE = 10140

// ---------- Ошибки ----------

/**
 * Ошибка API Директа: сохраняет error_code / error_detail / request_id,
 * чтобы диагностика не терялась. Токен в message НЕ попадает.
 */
export class DirectApiError extends Error {
  readonly code: number
  readonly detail?: string
  readonly requestId?: string

  constructor(message: string, code: number, detail?: string, requestId?: string) {
    super(message)
    this.name = 'DirectApiError'
    this.code = code
    this.detail = detail
    this.requestId = requestId
  }
}

interface DirectErrorPayload {
  error_code: number
  error_string: string
  error_detail?: string
  request_id?: string
}

interface DirectResponseBody {
  result?: unknown
  error?: DirectErrorPayload
}

// ---------- Базовый вызов ----------

/**
 * Базовый вызов API Директа v5: POST /json/v5/{service} с телом {method, params}.
 *
 * Разбирает конверт { result } / { error }: при ошибке кидает DirectApiError
 * с code/string/detail/request_id (без токена). При HTTP-ошибке без JSON-тела
 * кидает DirectApiError с HTTP-статусом в code.
 */
export async function directCall<T = unknown>(
  service: string,
  method: string,
  params: unknown
): Promise<T> {
  const token = readYandexDirectToken()

  const res = await fetch(`${DIRECT_API_BASE}/${service}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Language': 'ru',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ method, params }),
  })

  const text = await res.text()
  let body: DirectResponseBody | undefined
  try {
    body = JSON.parse(text) as DirectResponseBody
  } catch {
    body = undefined
  }

  if (body?.error) {
    const e = body.error
    throw new DirectApiError(
      `[direct] ${service}.${method} failed: code=${e.error_code} ${e.error_string}` +
        (e.error_detail ? ` — ${e.error_detail}` : '') +
        (e.request_id ? ` (request_id=${e.request_id})` : ''),
      e.error_code,
      e.error_detail,
      e.request_id
    )
  }

  if (!res.ok) {
    throw new DirectApiError(`[direct] ${service}.${method} failed: HTTP ${res.status}`, res.status)
  }

  return body?.result as T
}

// ---------- Read-хелперы (всё по боевой кампании DIRECT_CAMPAIGN_ID) ----------

/** Настройка кампании из TextCampaign.Settings ({Option, Value}). */
export interface CampaignSetting {
  Option: string
  Value: string
}

/** Состояние кампании из campaigns.get (поля, которые запрашиваем). */
export interface CampaignState {
  Id: number
  Name: string
  State: string
  Status: string
  StatusPayment: string
  Type: string
  DailyBudget?: { Amount: number; Mode: string }
  TextCampaign?: {
    BiddingStrategy?: unknown
    CounterIds?: { Items: number[] }
    Settings?: CampaignSetting[]
  }
}

/** Читает состояние боевой кампании (campaigns.get по DIRECT_CAMPAIGN_ID). */
export async function getCampaignState(): Promise<CampaignState> {
  const result = await directCall<{ Campaigns?: CampaignState[] }>('campaigns', 'get', {
    SelectionCriteria: { Ids: [DIRECT_CAMPAIGN_ID] },
    FieldNames: ['Id', 'Name', 'State', 'Status', 'StatusPayment', 'DailyBudget', 'Type'],
    TextCampaignFieldNames: ['BiddingStrategy', 'CounterIds', 'Settings'],
  })
  const campaign = result?.Campaigns?.[0]
  if (!campaign) {
    throw new Error(`[direct] campaigns.get: кампания ${DIRECT_CAMPAIGN_ID} не найдена в ответе`)
  }
  return campaign
}

/**
 * Достаёт значение настройки ADD_METRICA_TAG из TextCampaign.Settings.
 * Слетает в NO после ЛЮБОГО campaigns.update по TextCampaign — проверять
 * после каждого апдейта (см. restoreMetricaTag).
 */
export function getAddMetricaTagValue(campaign: CampaignState): 'YES' | 'NO' {
  const setting = campaign.TextCampaign?.Settings?.find((s) => s.Option === 'ADD_METRICA_TAG')
  return setting?.Value === 'YES' ? 'YES' : 'NO'
}

/** Ключевая фраза из keywords.get. */
export interface KeywordRecord {
  Id: number
  Keyword: string
  AdGroupId: number
  State: string
  Status: string
  StatusClarification?: string
  Bid?: number
}

/** Сырой keywords.get с пагинацией (Page.Limit/Offset, продолжение по LimitedBy). */
async function getKeywordsRaw(): Promise<KeywordRecord[]> {
  const all: KeywordRecord[] = []
  let offset = 0
  for (;;) {
    const result = await directCall<{ Keywords?: KeywordRecord[]; LimitedBy?: number }>(
      'keywords',
      'get',
      {
        SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID] },
        FieldNames: ['Id', 'Keyword', 'AdGroupId', 'State', 'Status', 'StatusClarification', 'Bid'],
        Page: { Limit: PAGE_LIMIT, Offset: offset },
      }
    )
    all.push(...(result?.Keywords ?? []))
    if (result?.LimitedBy == null) break
    offset = result.LimitedBy
  }
  return all
}

/**
 * Ключевые фразы боевой кампании. Служебные записи автотаргета
 * (Keyword === '---autotargeting') отфильтрованы — это не настоящие ключи.
 */
export async function getKeywords(): Promise<KeywordRecord[]> {
  const raw = await getKeywordsRaw()
  return raw.filter((k) => k.Keyword !== AUTOTARGETING_KEYWORD)
}

/** Записи автотаргета (Keyword === '---autotargeting') — отдельно, без ключей. */
export async function getAutotargetingRecords(): Promise<KeywordRecord[]> {
  const raw = await getKeywordsRaw()
  return raw.filter((k) => k.Keyword === AUTOTARGETING_KEYWORD)
}

/** Позиция аукциона: суммы Bid/Price в МИКРОЕДИНИЦАХ. */
export interface AuctionBid {
  TrafficVolume: number
  Bid: number
  Price: number
}

/** Ставка ключа из keywordbids.get (поисковый срез). */
export interface KeywordBidRecord {
  KeywordId: number
  AdGroupId: number
  CampaignId: number
  Search?: {
    Bid?: number
    AuctionBids?: AuctionBid[]
  }
}

/** Ставки и аукцион по ключам боевой кампании (keywordbids.get, с пагинацией). */
export async function getKeywordBids(): Promise<KeywordBidRecord[]> {
  const all: KeywordBidRecord[] = []
  let offset = 0
  for (;;) {
    const result = await directCall<{ KeywordBids?: KeywordBidRecord[]; LimitedBy?: number }>(
      'keywordbids',
      'get',
      {
        SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID] },
        FieldNames: ['KeywordId', 'AdGroupId', 'CampaignId'],
        SearchFieldNames: ['Bid', 'AuctionBids'],
        Page: { Limit: PAGE_LIMIT, Offset: offset },
      }
    )
    all.push(...(result?.KeywordBids ?? []))
    if (result?.LimitedBy == null) break
    offset = result.LimitedBy
  }
  return all
}

// ---------- Write-транспорт (суммы в МИКРОЕДИНИЦАХ) ----------

/**
 * Установка поисковых ставок (keywordbids.set). Суммы в МИКРОЕДИНИЦАХ.
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function setKeywordBids(
  items: Array<{ keywordId: number; searchBidMicro: number }>
): Promise<unknown> {
  return directCall('keywordbids', 'set', {
    KeywordBids: items.map((i) => ({ KeywordId: i.keywordId, SearchBid: i.searchBidMicro })),
  })
}

/**
 * Замена минус-фраз кампании (campaigns.update). Список ПОЛНОСТЬЮ замещает
 * текущий — вызывающий код обязан передавать объединённый набор.
 *
 * КРИТИЧНО: NegativeKeywords живёт на ВЕРХНЕМ уровне Campaign,
 * НЕ внутри TextCampaign (подтверждено боевыми пробами).
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function updateCampaignNegatives(negativeKeywords: string[]): Promise<unknown> {
  return directCall('campaigns', 'update', {
    Campaigns: [
      {
        Id: DIRECT_CAMPAIGN_ID,
        NegativeKeywords: { Items: negativeKeywords },
      },
    ],
  })
}

/**
 * Возвращает настройку ADD_METRICA_TAG в YES.
 *
 * ADD_METRICA_TAG слетает в NO после ЛЮБОГО campaigns.update по TextCampaign —
 * после каждого такого апдейта нужно возвращать YES этим вызовом.
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function restoreMetricaTag(): Promise<unknown> {
  return directCall('campaigns', 'update', {
    Campaigns: [
      {
        Id: DIRECT_CAMPAIGN_ID,
        TextCampaign: { Settings: [{ Option: 'ADD_METRICA_TAG', Value: 'YES' }] },
      },
    ],
  })
}

/**
 * Остановка ключевых фраз (keywords.suspend).
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function suspendKeywords(ids: number[]): Promise<unknown> {
  return directCall('keywords', 'suspend', {
    SelectionCriteria: { Ids: ids },
  })
}

/**
 * Остановка ВСЕЙ боевой кампании (campaigns.suspend).
 *
 * ТОЛЬКО аварийно — катастрофа расхода (бюджет улетает из-за бага/аномалии).
 * В штатной работе кампанию не останавливаем.
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function suspendCampaign(): Promise<unknown> {
  return directCall('campaigns', 'suspend', {
    SelectionCriteria: { Ids: [DIRECT_CAMPAIGN_ID] },
  })
}

/**
 * Смена дневного бюджета (campaigns.update, DailyBudget.Amount в МИКРОЕДИНИЦАХ).
 *
 * Применяется ТОЛЬКО после явного «да» владельца — Борис сам бюджет не меняет
 * (инвариант из config.ts: DAILY_BUDGET_MICRO — предохранитель владельца).
 *
 * ВНИМАНИЕ: вызывать ТОЛЬКО через write-gate (src/lib/boris-direct/write-gate.ts),
 * в observe-режиме пишущие запросы запрещены.
 */
export async function updateDailyBudget(amountMicro: number): Promise<unknown> {
  return directCall('campaigns', 'update', {
    Campaigns: [
      {
        Id: DIRECT_CAMPAIGN_ID,
        DailyBudget: { Amount: amountMicro, Mode: 'STANDARD' },
      },
    ],
  })
}

// ---------- Разбор частичных ошибок write-ответов ----------

interface WriteIssueItem {
  Code: number
  Message: string
  Details?: string
}

interface WriteResultItem {
  Warnings?: WriteIssueItem[]
  Errors?: WriteIssueItem[]
}

export interface WriteIssues {
  errors: string[]
  warnings: string[]
}

function formatIssue(issue: WriteIssueItem): string {
  return `${issue.Code}: ${issue.Message}${issue.Details ? ` — ${issue.Details}` : ''}`
}

/**
 * Собирает Warnings/Errors из поэлементных массивов write-ответа
 * (UpdateResults у campaigns.update, SetResults у keywordbids.set и т.п.).
 *
 * Код 10140 (дубль ключевой фразы — Яндекс схлопывает сам) понижается
 * до warning, даже если пришёл в Errors: операция по факту применена.
 */
export function extractWriteIssues(result: unknown): WriteIssues {
  const issues: WriteIssues = { errors: [], warnings: [] }
  if (!result || typeof result !== 'object') return issues

  for (const value of Object.values(result as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const item of value as WriteResultItem[]) {
      for (const err of item?.Errors ?? []) {
        if (err.Code === DUPLICATE_KEYWORD_CODE) issues.warnings.push(formatIssue(err))
        else issues.errors.push(formatIssue(err))
      }
      for (const warn of item?.Warnings ?? []) {
        issues.warnings.push(formatIssue(warn))
      }
    }
  }
  return issues
}
