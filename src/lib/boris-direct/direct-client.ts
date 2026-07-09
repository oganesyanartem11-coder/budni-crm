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
        // FieldNames — только валидные поля keywords.get. StatusClarification
        // ЗДЕСЬ невалиден (это поле ads.get/campaigns.get) → код 8000; убран.
        FieldNames: ['Id', 'Keyword', 'AdGroupId', 'State', 'Status', 'Bid'],
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

/** Объявление из ads.get (поля, которые запрашиваем). */
export interface AdRecord {
  Id: number
  AdGroupId: number
  State: string
  Status: string
  StatusClarification?: string
}

/**
 * Объявления боевой кампании (ads.get, с пагинацией как у getKeywords).
 *
 * ТОЛЬКО чтение — write-методов по объявлениям НЕТ и быть не должно
 * (инвариант: объявления вне разрешённого набора write-операций).
 */
export async function getAds(): Promise<AdRecord[]> {
  const all: AdRecord[] = []
  let offset = 0
  for (;;) {
    const result = await directCall<{ Ads?: AdRecord[]; LimitedBy?: number }>('ads', 'get', {
      SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID] },
      FieldNames: ['Id', 'AdGroupId', 'State', 'Status', 'StatusClarification'],
      Page: { Limit: PAGE_LIMIT, Offset: offset },
    })
    all.push(...(result?.Ads ?? []))
    if (result?.LimitedBy == null) break
    offset = result.LimitedBy
  }
  return all
}

/** Позиция аукциона: суммы Bid/Price в МИКРОЕДИНИЦАХ. */
export interface AuctionBid {
  TrafficVolume: number
  Bid: number
  Price: number
}

/** Ставка ключа из keywordbids.get (поисковый срез, УЖЕ нормализовано). */
export interface KeywordBidRecord {
  KeywordId: number
  AdGroupId: number
  CampaignId: number
  Search?: {
    Bid?: number
    /** Плоский массив позиций аукциона (после нормализации сырой формы API). */
    AuctionBids?: AuctionBid[]
  }
}

// Нормализация сырой формы keywordbids.get вынесена в отдельный НЕмокаемый
// модуль (keywordbids-normalize.ts): в полигоне этот модуль подменяется фейком,
// поэтому фейк не может импортировать нормализатор отсюда (цикл) — он берёт его
// из общего модуля. Реэкспорт сохраняет прежний публичный API direct-client.
export {
  normalizeAuctionBids,
  normalizeKeywordBidRecord,
  type RawKeywordBidRecord,
} from './keywordbids-normalize'
import { normalizeKeywordBidRecord, type RawKeywordBidRecord } from './keywordbids-normalize'

// ---------- Разведочные чтения (сессия «Прозрение»): корректировки, группы,
// расписание, внешние правки. ТОЛЬКО чтение — write по ним НЕ добавляем. ----------

/** Корректировка ставки из bidmodifiers.get (значения вложены по типу). */
export interface BidModifierRecord {
  Id: number
  CampaignId: number | null
  AdGroupId: number | null
  Level: string
  Type: string
  MobileAdjustment?: { BidModifier?: number; OperatingSystemType?: string }
  DesktopAdjustment?: { BidModifier?: number }
  DemographicsAdjustment?: { Age?: string; Gender?: string; BidModifier?: number }
  RegionalAdjustment?: { RegionId?: number; BidModifier?: number }
  RetargetingAdjustment?: { RetargetingConditionId?: number; BidModifier?: number }
}

/**
 * Корректировки ставок боевой кампании (bidmodifiers.get) — устройства,
 * демография, гео, аудитории. Levels ОБЯЗАТЕЛЕН (подтверждено кабинетом:
 * без него код 8000). ТОЛЬКО чтение.
 */
export async function getBidModifiers(): Promise<BidModifierRecord[]> {
  const result = await directCall<{ BidModifiers?: BidModifierRecord[] }>('bidmodifiers', 'get', {
    SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID], Levels: ['CAMPAIGN', 'AD_GROUP'] },
    FieldNames: ['Id', 'CampaignId', 'AdGroupId', 'Type', 'Level'],
    MobileAdjustmentFieldNames: ['BidModifier', 'OperatingSystemType'],
    DesktopAdjustmentFieldNames: ['BidModifier'],
    DemographicsAdjustmentFieldNames: ['Age', 'Gender', 'BidModifier'],
    RegionalAdjustmentFieldNames: ['RegionId', 'BidModifier'],
    RetargetingAdjustmentFieldNames: ['RetargetingConditionId', 'BidModifier'],
  })
  return result?.BidModifiers ?? []
}

/** Группа объявлений из adgroups.get (NegativeKeywords уровня группы). */
export interface AdGroupRecord {
  Id: number
  Name: string
  CampaignId: number
  Status: string
  Type: string
  RegionIds?: number[]
  NegativeKeywords?: { Items: string[] } | null
}

/**
 * Группы боевой кампании (adgroups.get) — структура + групповые минус-фразы.
 * Нужно для диагноза GROUP_MINUS_GAP и точной чистки. ТОЛЬКО чтение.
 */
export async function getAdGroups(): Promise<AdGroupRecord[]> {
  const result = await directCall<{ AdGroups?: AdGroupRecord[] }>('adgroups', 'get', {
    SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID] },
    FieldNames: ['Id', 'Name', 'CampaignId', 'Status', 'Type', 'NegativeKeywords', 'RegionIds'],
  })
  return result?.AdGroups ?? []
}

/** Расписание показов из campaigns.get (TimeTargeting). */
export interface TimeTargeting {
  Schedule?: { Items?: string[] }
  ConsiderWorkingWeekends?: string
  HolidaysSchedule?: unknown
}

/** Полные настройки кампании: расписание + живой список минус-фраз кампании. */
export interface CampaignSettings {
  Id: number
  Name: string
  TimeZone?: string
  StartDate?: string
  TimeTargeting?: TimeTargeting
  NegativeKeywords?: { Items: string[] } | null
  Statistics?: { Clicks?: number; Impressions?: number }
}

/**
 * Расширенные настройки кампании (campaigns.get с полным набором полей).
 * В ОТЛИЧИЕ от getCampaignState (горячий путь) читает TimeTargeting и живой
 * NegativeKeywords — для диагнозов SCHEDULE_WASTE и GROUP_MINUS_GAP.
 * Имена полей выверены по кабинету (ContextLimit невалиден — исключён).
 * ТОЛЬКО чтение.
 */
export async function getCampaignSettings(): Promise<CampaignSettings> {
  const result = await directCall<{ Campaigns?: CampaignSettings[] }>('campaigns', 'get', {
    SelectionCriteria: { Ids: [DIRECT_CAMPAIGN_ID] },
    FieldNames: ['Id', 'Name', 'TimeZone', 'StartDate', 'TimeTargeting', 'NegativeKeywords', 'Statistics'],
  })
  const campaign = result?.Campaigns?.[0]
  if (!campaign) {
    throw new Error(`[direct] campaigns.get(settings): кампания ${DIRECT_CAMPAIGN_ID} не найдена`)
  }
  return campaign
}

// changes.check (детект внешних правок владельца) — СОЗНАТЕЛЬНО НЕ добавлен:
// точная структура запроса/ответа не выверена боевой пробой, а инвариант
// запрещает угадывать незнакомую структуру API. Остаётся 🔴 в TOOLS_GAP до
// подтверждённого read-зонда (не блокирует ни один из 4 диагнозов сессии).

/** Ставки и аукцион по ключам боевой кампании (keywordbids.get, с пагинацией). */
export async function getKeywordBids(): Promise<KeywordBidRecord[]> {
  const all: KeywordBidRecord[] = []
  let offset = 0
  for (;;) {
    const result = await directCall<{ KeywordBids?: RawKeywordBidRecord[]; LimitedBy?: number }>(
      'keywordbids',
      'get',
      {
        SelectionCriteria: { CampaignIds: [DIRECT_CAMPAIGN_ID] },
        FieldNames: ['KeywordId', 'AdGroupId', 'CampaignId'],
        SearchFieldNames: ['Bid', 'AuctionBids'],
        Page: { Limit: PAGE_LIMIT, Offset: offset },
      }
    )
    // Нормализуем сырую форму AuctionBids ({AuctionBidItems}) → плоский массив
    // на границе транспорта: снапшот и весь код ниже видят только чистый массив.
    for (const raw of result?.KeywordBids ?? []) all.push(normalizeKeywordBidRecord(raw))
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

/** Поэлементный вердикт write-ответа для гейта: сколько элементов и какие провалились. */
export interface WriteOutcome {
  /** Число поэлементных результатов (длина SetResults/UpdateResults/SuspendResults…). */
  total: number
  /**
   * Индексы ПРОВАЛИВШИХСЯ элементов (в порядке ответа = порядке отправки).
   * Код 10140 (дубль, Яндекс схлопывает сам) провалом НЕ считается.
   */
  failedIndices: number[]
  errors: string[]
  warnings: string[]
}

/**
 * Поэлементный разбор write-ответа для write-gate: в отличие от extractWriteIssues
 * (плоские списки для скриптов) отдаёт СТРУКТУРУ — total и индексы провалившихся
 * элементов. Из неё гейт решает: провал ВСЕХ элементов → applied=false без
 * фантомного after; провал ЧАСТИ → after только по применённым.
 *
 * Элементом считается каждая запись в любом массиве-значении верхнего уровня
 * ответа (SetResults/UpdateResults/SuspendResults). Индексация сквозная в порядке
 * обхода — для наших write-методов массив всегда один и его порядок совпадает
 * с порядком отправленных элементов. Код 10140 (дубль) понижается до warning:
 * операция по факту применена, элемент проваленным не помечается.
 */
export function classifyWriteResult(result: unknown): WriteOutcome {
  const outcome: WriteOutcome = { total: 0, failedIndices: [], errors: [], warnings: [] }
  if (!result || typeof result !== 'object') return outcome

  let index = 0
  for (const value of Object.values(result as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const item of value as WriteResultItem[]) {
      const idx = index++
      let elementFailed = false
      for (const err of item?.Errors ?? []) {
        if (err.Code === DUPLICATE_KEYWORD_CODE) {
          outcome.warnings.push(formatIssue(err))
        } else {
          outcome.errors.push(formatIssue(err))
          elementFailed = true
        }
      }
      for (const warn of item?.Warnings ?? []) {
        outcome.warnings.push(formatIssue(warn))
      }
      if (elementFailed) outcome.failedIndices.push(idx)
    }
  }
  outcome.total = index
  return outcome
}
