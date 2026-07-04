/**
 * Фейк транспорта API Директа для полигона: те же экспорты и сигнатуры, что
 * у src/lib/boris-direct/direct-client.ts, но чтение — из мира симуляции,
 * запись — мутаторы движка + CapturedAction в контекст.
 *
 * ЧТЕНИЕ (без правды мира — только видимое состояние кампании и наблюдаемое
 * по дням): getCampaignState/getKeywords/getAds — из world.config и видимых
 * полей world; getKeywordBids — из ПОСЛЕДНЕГО DayObservables (снимок аукциона
 * «на сегодня», как отдал бы Директ).
 *
 * ЗАПИСЬ: каждый write зовёт мутатор движка (эффект со следующего дня) и
 * пушит CapturedAction{day: ctx.clockDay, by: ctx.policy}. Исключение —
 * updateDailyBudget: ТОЛЬКО captured, мир не трогаем (бюджет в модели мира
 * не участвует, но факт попытки скорер должен видеть).
 *
 * Особенность типов: в симуляции id групп СТРОКОВЫЕ ('G1'), а реальные типы
 * Директа объявляют AdGroupId: number. Кастуем строку в number на уровне
 * типов (runtime остаётся строкой) — боевой код ВСЕГДА делает String(AdGroupId)
 * перед сравнением с adGroupId отчётов, поэтому матчинг сходится.
 */

import { getCtx } from './context'
import {
  DAILY_BUDGET_MICRO,
  DIRECT_CAMPAIGN_ID,
  METRIKA_COUNTER_ID,
} from '../../src/lib/boris-direct/config'
import type {
  AdRecord,
  CampaignState,
  KeywordBidRecord,
  KeywordRecord,
  WriteIssues,
} from '../../src/lib/boris-direct/direct-client'

// Паритет экспортов типов с реальным модулем (type-only — в runtime стирается).
export type {
  AdRecord,
  AuctionBid,
  CampaignSetting,
  CampaignState,
  KeywordBidRecord,
  KeywordRecord,
  WriteIssues,
  BidModifierRecord,
  AdGroupRecord,
  TimeTargeting,
  CampaignSettings,
} from '../../src/lib/boris-direct/direct-client'

/** Код Директа «дубль ключевой фразы» — как в реальном модуле (warning). */
const DUPLICATE_KEYWORD_CODE = 10140

// ---------- Ошибки (зеркало реального класса; в симуляции никто не ловит) ----------

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

/** Сырой directCall в симуляции не поддержан — фейк реализует только хелперы. */
export async function directCall<T = unknown>(
  service: string,
  method: string,
  _params: unknown
): Promise<T> {
  throw new Error(`[sim/fakes/direct-client] directCall(${service}.${method}) не поддержан в симуляции`)
}

// ---------- Чтение ----------

/** Состояние «боевой» кампании из видимых полей мира. */
export async function getCampaignState(): Promise<CampaignState> {
  const { world } = getCtx()
  return {
    Id: DIRECT_CAMPAIGN_ID,
    Name: world.config.name,
    State: world.campaignSuspended ? 'SUSPENDED' : 'ON',
    Status: 'ACCEPTED',
    StatusPayment: 'ALLOWED',
    Type: 'TEXT_CAMPAIGN',
    DailyBudget: { Amount: DAILY_BUDGET_MICRO, Mode: 'STANDARD' },
    TextCampaign: {
      CounterIds: { Items: [METRIKA_COUNTER_ID] },
      Settings: [{ Option: 'ADD_METRICA_TAG', Value: world.addMetricaTag }],
    },
  }
}

/** Чистый хелпер — честный дубль реального (поведение один в один). */
export function getAddMetricaTagValue(campaign: CampaignState): 'YES' | 'NO' {
  const setting = campaign.TextCampaign?.Settings?.find((s) => s.Option === 'ADD_METRICA_TAG')
  return setting?.Value === 'YES' ? 'YES' : 'NO'
}

/** Ключевые фразы кампании из конфига сценария + текущие ставки/остановки мира. */
export async function getKeywords(): Promise<KeywordRecord[]> {
  const { world } = getCtx()
  return world.config.phrases.map((p) => ({
    Id: p.keywordId,
    Keyword: p.text,
    AdGroupId: p.adGroupId as unknown as number, // строковый id мира, см. шапку
    State: world.keywordsSuspended.has(p.keywordId) ? 'SUSPENDED' : 'ON',
    Status: 'ACCEPTED',
    Bid: world.bidsMicro.get(p.keywordId) ?? Math.round(p.startBidMicro),
  }))
}

/** Автотаргета в мире симуляции нет — пусто (как отфильтрованный keywords.get). */
export async function getAutotargetingRecords(): Promise<KeywordRecord[]> {
  return []
}

/** Объявления: Status REJECTED с дня rejectedFromDay (модерация «сработала»). */
export async function getAds(): Promise<AdRecord[]> {
  const { world } = getCtx()
  return world.config.ads.map((a) => ({
    Id: a.adId,
    AdGroupId: a.adGroupId as unknown as number,
    State: 'ON',
    Status: a.rejectedFromDay !== null && a.rejectedFromDay <= world.day ? 'REJECTED' : 'ACCEPTED',
  }))
}

/**
 * Ставки и аукцион «на сегодня» — из ПОСЛЕДНЕГО наблюдаемого дня
 * (движок кладёт снимок аукциона в DayObservables.keywordBids).
 * Дней ещё нет → пусто (мозг корректно пропускает блок ставок).
 */
export async function getKeywordBids(): Promise<KeywordBidRecord[]> {
  const ctx = getCtx()
  const latest = ctx.days[ctx.days.length - 1]
  if (!latest) return []
  return latest.keywordBids.map((b) => ({
    KeywordId: b.keywordId,
    AdGroupId: b.adGroupId as unknown as number,
    CampaignId: DIRECT_CAMPAIGN_ID,
    Search: {
      Bid: b.bidMicro,
      AuctionBids: b.auction.map((a) => ({
        TrafficVolume: a.tv,
        Bid: a.bidMicro,
        Price: a.priceMicro,
      })),
    },
  }))
}

// ---------- Разведочные чтения (сессия «Прозрение») ----------
// По умолчанию НЕЙТРАЛЬНЫ: корректировок нет, расписание задано (SCHEDULE_WASTE
// молчит), device/demo-срезы Метрики пусты (DEVICE_SKEW/AUDIENCE_WASTE молчат) —
// текущая линейка полигона НЕ меняется. Витку «догнать полигон» (ШАГ 3) здесь
// подкладываются реальные сигналы (мёртвые часы/выходные, перекос устройств).

import type {
  AdGroupRecord,
  BidModifierRecord,
  CampaignSettings,
} from '../../src/lib/boris-direct/direct-client'

/** Корректировок в базовом мире нет (ШАГ 3 может подложить через ctx/world). */
export async function getBidModifiers(): Promise<BidModifierRecord[]> {
  const over = (getCtx().world.internal as { bidModifiers?: BidModifierRecord[] } | undefined)?.bidModifiers
  return over ?? []
}

/** Группы из конфига сценария; групповых минусов в базовом мире нет. */
export async function getAdGroups(): Promise<AdGroupRecord[]> {
  const { world } = getCtx()
  const byId = new Map<string, { id: string; name: string }>()
  for (const p of world.config.phrases) {
    if (!byId.has(p.adGroupId)) byId.set(p.adGroupId, { id: p.adGroupId, name: p.adGroupName })
  }
  return [...byId.values()].map((g) => ({
    Id: g.id as unknown as number,
    Name: g.name,
    CampaignId: DIRECT_CAMPAIGN_ID,
    Status: 'ACCEPTED',
    Type: 'TEXT_AD_GROUP',
    RegionIds: [1],
    NegativeKeywords: null,
  }))
}

/**
 * Настройки кампании: расписание ПРИСУТСТВУЕТ (hasSchedule=true) — значит
 * SCHEDULE_WASTE в базовом мире молчит; живой список минусов кампании — из
 * world.negatives (то, что Борис реально навесил). ШАГ 3 может убрать
 * расписание через world.internal, чтобы зажечь диагноз.
 */
export async function getCampaignSettings(): Promise<CampaignSettings> {
  const { world } = getCtx()
  const noSchedule = (world.internal as { noSchedule?: boolean } | undefined)?.noSchedule === true
  return {
    Id: DIRECT_CAMPAIGN_ID,
    Name: world.config.name,
    TimeZone: 'Europe/Moscow',
    StartDate: '2026-06-30',
    TimeTargeting: noSchedule ? undefined : { Schedule: { Items: [] }, ConsiderWorkingWeekends: 'NO' },
    NegativeKeywords: { Items: [...world.negatives] },
    Statistics: { Clicks: 0, Impressions: 0 },
  }
}

// ---------- Запись (мутатор движка + CapturedAction; суммы в МИКРОЕДИНИЦАХ) ----------

/** Установка поисковых ставок: engine.setBid по каждой + captured 'bid_set'. */
export async function setKeywordBids(
  items: Array<{ keywordId: number; searchBidMicro: number }>
): Promise<unknown> {
  const ctx = getCtx()
  for (const item of items) {
    ctx.engine.setBid(ctx.world, item.keywordId, item.searchBidMicro)
  }
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'bid_set',
    // Форма payload — по закону sim/types.ts: [{keywordId, toMicro}].
    payload: items.map((i) => ({ keywordId: i.keywordId, toMicro: i.searchBidMicro })),
    by: ctx.policy,
  })
  // Как у Директа: поэлементный результат без Warnings/Errors.
  return { SetResults: items.map((i) => ({ KeywordId: i.keywordId })) }
}

/** Полная замена минус-фраз кампании: engine.setNegatives + captured 'negatives_set'. */
export async function updateCampaignNegatives(negativeKeywords: string[]): Promise<unknown> {
  const ctx = getCtx()
  ctx.engine.setNegatives(ctx.world, negativeKeywords)
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'negatives_set',
    // Полный новый список (семантика campaigns.update — замещение).
    payload: [...negativeKeywords],
    by: ctx.policy,
  })
  return { UpdateResults: [{ Id: DIRECT_CAMPAIGN_ID }] }
}

/** Возврат ADD_METRICA_TAG=YES: engine.setMetricaTag + captured 'metrica_tag_restore'. */
export async function restoreMetricaTag(): Promise<unknown> {
  const ctx = getCtx()
  ctx.engine.setMetricaTag(ctx.world, 'YES')
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'metrica_tag_restore',
    payload: { value: 'YES' },
    by: ctx.policy,
  })
  return { UpdateResults: [{ Id: DIRECT_CAMPAIGN_ID }] }
}

/** Остановка фраз: engine.suspendKeywords + captured 'keywords_suspend'. */
export async function suspendKeywords(ids: number[]): Promise<unknown> {
  const ctx = getCtx()
  ctx.engine.suspendKeywords(ctx.world, ids)
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'keywords_suspend',
    payload: { ids: [...ids] },
    by: ctx.policy,
  })
  return { SuspendResults: ids.map((id) => ({ Id: id })) }
}

/** Аварийная остановка кампании: engine.suspendCampaign + captured 'campaign_suspend'. */
export async function suspendCampaign(): Promise<unknown> {
  const ctx = getCtx()
  ctx.engine.suspendCampaign(ctx.world)
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'campaign_suspend',
    payload: { campaignId: DIRECT_CAMPAIGN_ID },
    by: ctx.policy,
  })
  return { SuspendResults: [{ Id: DIRECT_CAMPAIGN_ID }] }
}

/**
 * Смена дневного бюджета: ТОЛЬКО captured 'daily_budget' — мир НЕ трогаем
 * (бюджет в модели мира не участвует; скореру важен сам факт попытки).
 */
export async function updateDailyBudget(amountMicro: number): Promise<unknown> {
  const ctx = getCtx()
  ctx.captured.push({
    day: ctx.clockDay,
    type: 'daily_budget',
    payload: { amountMicro },
    by: ctx.policy,
  })
  return { UpdateResults: [{ Id: DIRECT_CAMPAIGN_ID }] }
}

// ---------- Разбор частичных ошибок write-ответов (честный дубль реального) ----------

interface WriteIssueItem {
  Code: number
  Message: string
  Details?: string
}

interface WriteResultItem {
  Warnings?: WriteIssueItem[]
  Errors?: WriteIssueItem[]
}

function formatIssue(issue: WriteIssueItem): string {
  return `${issue.Code}: ${issue.Message}${issue.Details ? ` — ${issue.Details}` : ''}`
}

/** Поведение один в один с реальным extractWriteIssues (10140 → warning). */
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
