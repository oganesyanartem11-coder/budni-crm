// Мозг роли «трафик» (Борис-Директ): дневной цикл в ДВА тика под Vercel
// serverless (в функции не сидим минутами, отчёты дозреют к следующему тику).
//
// Тик «сбор» (runCollectTick): снапшоты состояния кампании + заказ отчётов
// за вчера + детекция аномалий по вчерашним данным.
//
// Тик «обработка» (runProcessTick): дожать отчёты → карантин? → минуса →
// ставки → данные для дневного отчёта. Каждый блок в try/catch — ошибка
// одного блока не роняет тик.
//
// Гибрид: ВСЯ арифметика здесь и в rules.ts; LLM (light) — только один
// классификатор структурного мусора в минусовке. Все пишущие операции —
// ТОЛЬКО через write-gate.

import { prisma } from '@/lib/db/prisma'
import type { Prisma } from '@prisma/client'
import {
  getCampaignState,
  getAddMetricaTagValue,
  getKeywords,
  getKeywordBids,
  getAds,
  getBidModifiers,
  getAdGroups,
  getCampaignSettings,
  type CampaignState,
  type KeywordRecord,
  type KeywordBidRecord,
  type AdRecord,
  type BidModifierRecord,
  type CampaignSettings,
} from './direct-client'
import {
  buildSearchQueryReportBody,
  buildCampaignPerformanceReportBody,
  buildCriterionHistoryReportBody,
  buildDeviceReportBody,
  pollReport,
  parseReportTsv,
} from './reports'
import {
  getGoalStatsByDay,
  getGoalStatsByDevice,
  getGoalStatsByDemographics,
  getGoalStatsByHour,
  getGoalStatsByPhrase,
} from './metrika-client'
import {
  diagnoseDeviceSkew,
  diagnoseScheduleWaste,
  diagnoseAudienceWaste,
  diagnoseGroupMinusGap,
  normalizeDevice,
  adjustedDeviceTypes,
  adjustedDemoSegments,
  buildDemoSegments,
  isWeekend,
  type DeviceRow,
} from './diagnostics'
import {
  getLeadsForPeriod,
  splitLeadsByOrigin,
  matchLeadsToTerms,
  toQueryStatRow,
  computeCostPerLead,
  readReportConversions,
  parseCriterionId,
  type QueryStatRow,
} from './attribution'
import type { DecisionRecord, ReasonCode } from './reason-codes'
import {
  DIRECT_CAMPAIGN_ID,
  DATA_MISMATCH_RATIO,
  DATA_MISMATCH_MIN_COUNT,
  PHRASE_ECON_WINDOW_DAYS,
  PHRASE_ECON_WINDOW_WORKDAYS,
  CONVERTER_PROTECT_WINDOW_WORKDAYS,
  PRIOR_CR_FALLBACK,
  TV_LOWER_BLOCK_ENTRY,
  TV_TAIL,
} from './config'
import { phraseBidVerdict } from './bayes'
import { workdayWindowStartUtc, isWorkday } from './workdays'
import { underspendGateOpen, recommendMarginalBid, type UnderspendGate } from './underspend'
import {
  resolveLevel,
  serializeLevels,
  deserializeLevels,
  type PhraseLevelMap,
  type PhraseLevelSnapshot,
} from './level-lock'
import {
  selectRampInSubset,
  formatCbStoppedPlan,
  type EnrichedChange,
  type CbStoppedChange,
} from './ramp-in'
import {
  MICRO,
  UNDERSPEND_WINDOW_WORKDAYS,
  LEADS_ZERO_AVG_WORKDAYS,
  MARGINAL_UPLIFT_ENABLED,
  MARGINAL_CPL_CAP_PCT,
  getLeadValueRub,
} from './config'
import { detectAnomalies, detectLeadReconcileLoss, type Anomaly } from './anomalies'
import { classifyQueryGeo, isGeoMinusReason } from './geo'
import {
  isProtectedConverter,
  filterOutProtectedConverters,
  CONVERTER_PROTECT_WINDOW_DAYS,
} from './economics'
import { isRegisteredConverter } from './converters'
import { filterOutTestLeads } from './test-markers'
import { phantomWeight } from './phantom'
import {
  decideQuarantine,
  pickDataDrivenMinusCandidates,
  prepareMinusCandidates,
  recommendBid,
  pickBehavioralMinusCandidates,
  type PhraseBehaviorRow,
  type RecommendBidResult,
} from './rules'
import { applyBidChanges, addNegativeKeywords } from './write-gate'
import { getDirectRoleState } from './state'
import { deriveAndRefreshLessons } from './lessons'
import {
  measureActionOutcomes,
  measureProposalOutcomes,
  generateCorrectionProposals,
} from './outcomes'
import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDoctrineBlock } from './doctrine'

// ---------- Время: МСК = UTC+3 ----------

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MSK_OFFSET_MS = 3 * HOUR_MS

/** МСК-день даты в виде 'YYYY-MM-DD'. */
export function mskDay(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
}

/** Нормализация текста запроса/ключа для моста «текст ↔ keywordId» (Цикл 2.0):
 *  lower, ё→е, схлопывание пробелов. В симуляции тексты совпадают точно;
 *  в бою страхует регистр/пробелы. */
function normQueryKey(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

/** Начало МСК-дня 'YYYY-MM-DD' как UTC-момент (для tickDate и границ выборок). */
export function mskDayStartUtc(day: string): Date {
  return new Date(`${day}T00:00:00+03:00`)
}

/** Вчерашний МСК-день как {dateFrom, dateTo} 'YYYY-MM-DD' (для отчётов). */
export function yesterdayMsk(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const day = mskDay(new Date(now.getTime() - DAY_MS))
  return { dateFrom: day, dateTo: day }
}

/** Понедельник по МСК — день еженедельной дистилляции уроков. */
function isMondayMsk(now: Date): boolean {
  return new Date(now.getTime() + MSK_OFFSET_MS).getUTCDay() === 1
}

// ---------- Снапшоты ----------

/** Дневные итоги из отчёта эффективности — пишутся тиком «обработка»,
 * читаются тиком «сбор» для детекции аномалий (расход/показы к среднему). */
interface DailyTotals {
  date: string
  spendRub: number
  clicks: number
  impressions: number
}

async function saveSnapshot(tickDate: Date, kind: string, payload: unknown): Promise<void> {
  await prisma.borisDirectSnapshot.create({
    data: {
      tickDate,
      kind,
      payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
    },
  })
}

/** Последний снапшот вида kind (свежайший тик побеждает) — или null. */
async function latestSnapshotPayload<T>(kind: string): Promise<T | null> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  return snap ? (snap.payload as unknown as T) : null
}

/** Payload снапшота kind, ПРИВЯЗАННЫЙ к конкретному МСК-дню (tickDate). null — нет
 * записи за этот день (напр. Метрика в тот день не отдалась) → сверку не делаем. */
async function snapshotPayloadForDay<T>(kind: string, tickDate: Date): Promise<T | null> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind, tickDate },
    orderBy: { createdAt: 'desc' },
  })
  return snap ? (snap.payload as unknown as T) : null
}

/** Дневные итоги за days МСК-дней до endInclusive (последняя запись на день побеждает). */
async function loadDailyTotals(endInclusive: Date, days: number): Promise<DailyTotals[]> {
  const from = new Date(endInclusive.getTime() - (days - 1) * DAY_MS)
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'daily_totals', tickDate: { gte: from, lte: endInclusive } },
    orderBy: { createdAt: 'asc' },
  })
  const byDay = new Map<string, DailyTotals>()
  for (const snap of snaps) {
    const totals = snap.payload as unknown as DailyTotals
    if (totals?.date) byDay.set(totals.date, totals)
  }
  return [...byDay.values()]
}

/** Дневной агрегат SQ по ключу (CriterionId) — единица снапшота 'query_criterion_daily'. */
interface CriterionDayStat {
  criterionId: number
  clicks: number
  conversions: number
}

/**
 * Окно пофразной экономики ПО КЛЮЧУ (MAJOR-2): суммирует снапшоты
 * 'query_criterion_daily' за days МСК-дней до endInclusive в Map<criterionId,
 * {clicks, conversions}>. Каждый снапшот — уже агрегат дня по CriterionId;
 * дубликаты дня (ретраи тика) схлопываем — последняя запись на tickDate
 * побеждает. Старые тики (до перехода на ID) этого вида снапшота НЕ писали →
 * их дни просто отсутствуют (мягкая совместимость: ключ без истории окна
 * останется «тонким» → hold, без гадания по тексту).
 */
async function loadCriterionWindow(
  endInclusive: Date,
  workdays: number
): Promise<Map<number, { clicks: number; conversions: number }>> {
  const acc = new Map<number, { clicks: number; conversions: number }>()
  if (workdays <= 0) return acc
  // М3: окно в РАБОЧИХ днях (B2B живёт по будням; 14 календ. окно = 10 рабочих).
  const from = workdayWindowStartUtc(mskDay(endInclusive), workdays)
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'query_criterion_daily', tickDate: { gte: from, lte: endInclusive } },
    orderBy: { createdAt: 'asc' },
  })
  // Дедуп по дню: последний снапшот на tickDate побеждает (идемпотентный агрегат дня).
  const byDay = new Map<number, CriterionDayStat[]>()
  for (const snap of snaps) {
    byDay.set(snap.tickDate.getTime(), (snap.payload as unknown as CriterionDayStat[]) ?? [])
  }
  for (const list of byDay.values()) {
    for (const s of list) {
      if (typeof s?.criterionId !== 'number') continue
      const cur = acc.get(s.criterionId) ?? { clicks: 0, conversions: 0 }
      cur.clicks += s.clicks
      cur.conversions += s.conversions
      acc.set(s.criterionId, cur)
    }
  }
  return acc
}

/**
 * Истинный КУМУЛЯТИВ кликов кампании из Reports API за [startDate … dateTo]
 * — для карантинного гейта. ОТДЕЛЬНЫЙ от суточного отчёта фетч: суточный
 * пайплайн (buildCampaignPerformanceReportBody(yesterday, yesterday)) не трогаем.
 * Read-only: один report-job поллится эфемерно, БЕЗ записи BorisDirectReportJob.
 *
 * Возвращает null при ЛЮБОЙ невозможности назвать число (нет StartDate / отчёт
 * failed / всё ещё pending после лимита попыток / пустой TSV) — вызывающий
 * трактует null как карантин (fail-safe). Никогда не возвращает 0 «по-тихому»
 * из-за недоступности: 0 — только если отчёт реально пришёл с нулём кликов.
 */
async function fetchCumulativeCampaignClicks(
  startDate: string | null,
  dateTo: string
): Promise<number | null> {
  if (!startDate) return null
  const compact = `${startDate.replace(/-/g, '')}_${dateTo.replace(/-/g, '')}`
  const reportName = `bd_cum_${compact}_${Date.now()}`
  // ТОТ ЖЕ body переиспользуется при поллинге (стабильный ReportName) — требование
  // Reports API: повторный POST того же отчёта отдаёт его же, 200 когда готов.
  const body = buildCampaignPerformanceReportBody(startDate, dateTo, reportName)
  const MAX_ATTEMPTS = 5
  const MAX_WAIT_SEC = 10
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let poll
    try {
      poll = await pollReport(body)
    } catch (err) {
      console.error('[boris-direct/brain] карантин: кумулятив-отчёт — сеть упала', err)
      return null
    }
    if (poll.status === 'ready') {
      const rows = parseReportTsv(poll.tsv)
      if (rows.length === 0) return null // пусто → не подтвердили кумулятив
      return rows.reduce((acc, r) => acc + tsvNumber(r.Clicks), 0)
    }
    if (poll.status === 'failed') {
      console.error(`[boris-direct/brain] карантин: кумулятив-отчёт failed — ${poll.error}`)
      return null
    }
    // pending → ждём (retryIn, но не дольше MAX_WAIT_SEC) и повторяем ТОТ ЖЕ POST
    if (attempt < MAX_ATTEMPTS) {
      const waitSec = Math.min(poll.retryInSec, MAX_WAIT_SEC)
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000))
    }
  }
  return null // всё ещё pending после лимита → карантин из осторожности
}

/** Агрегат дня backfill: как CriterionDayStat + позиция (avgTrafficVolume). head
 *  читает первые 3 поля; позиция копится для будущего анализа позиция×CPL. */
interface CriterionDayStatBackfill extends CriterionDayStat {
  avgTrafficVolume: number
}

/**
 * ИДЕМПОТЕНТНЫЙ SELF-HEAL окна пофразной экономики: добирает из Reports дни
 * [StartDate … yesterday], которых НЕТ в снапшотах query_criterion_daily, и
 * пишет по ним снапшоты (форма CriterionDayStatBackfill — совместима с чтением
 * head: loadCriterionWindow читает criterionId/clicks/conversions, доп. поле
 * avgTrafficVolume игнорирует). История кампании живёт в Директе, но снапшоты
 * роли начались позже её старта — этот шаг закрывает разрыв.
 *
 * ДИАПАЗОН — StartDate..ПОЗАВЧЕРА: вчерашний день пишет тик «обработка» (SQ), а
 * backfill закрывает только ИСТОРИЧЕСКИЙ разрыв. Так, когда история догнана, шаг
 * — истинный no-op (отчёт не заказывается КАЖДЫЙ тик ради вчера); день, который
 * процесс пропустил, самолечится на следующем тике (лаг 1 день).
 *
 * ИДЕМПОТЕНТНОСТЬ: существующие дни (в т.ч. живые снапшоты тика «обработка») НЕ
 * перезаписываются — добираются только отсутствующие. Дыр нет → no-op.
 *
 * FAIL-SAFE: нет StartDate / отчёт не готов после лимита / failed / сеть упала →
 * 0 записей, дни НЕ помечаются (ретрай сам на следующем тике). Один эфемерный
 * report-job (БЕЗ записи BorisDirectReportJob), как у карантинного кумулятива.
 *
 * Строки автотаргета (числовой CriterionId 20<adGroupId>) пишутся в снапшот как
 * в тике «обработка» — при чтении head они отсекаются по liveKeyIds. Пустой/
 * нечисловой CriterionId в снапшот не идёт (в пофразную экономику не участвует).
 */
export async function backfillCriterionHistory(
  startDate: string | null,
  yesterday: string,
  _now: Date = new Date()
): Promise<{ backfilledDays: string[] }> {
  if (!startDate) return { backfilledDays: [] }
  const startTick = mskDayStartUtc(startDate)
  // Конец диапазона — ПОЗАВЧЕРА (вчера пишет тик «обработка»). Пусто → StartDate
  // ≥ вчера (совсем молодая кампания) → нечего добирать.
  const endTick = new Date(mskDayStartUtc(yesterday).getTime() - DAY_MS)
  if (startTick.getTime() > endTick.getTime()) return { backfilledDays: [] }

  // Какие дни диапазона уже есть в снапшотах?
  let existing: Array<{ tickDate: Date }>
  try {
    existing = await prisma.borisDirectSnapshot.findMany({
      where: { kind: 'query_criterion_daily', tickDate: { gte: startTick, lte: endTick } },
      select: { tickDate: true },
    })
  } catch (err) {
    console.error('[boris-direct/brain] backfill: чтение существующих дней упало', err)
    return { backfilledDays: [] }
  }
  const haveDays = new Set(existing.map((s) => mskDay(s.tickDate)))
  const missing: string[] = []
  for (let t = startTick.getTime(); t <= endTick.getTime(); t += DAY_MS) {
    const day = mskDay(new Date(t))
    if (!haveDays.has(day)) missing.push(day)
  }
  if (missing.length === 0) return { backfilledDays: [] }

  // ОДИН эфемерный отчёт за весь диапазон StartDate..позавчера (стабильный ReportName
  // при поллинге). Даты и порядок как у карантинного кумулятива.
  const endDay = mskDay(endTick)
  const compact = `${startDate.replace(/-/g, '')}_${endDay.replace(/-/g, '')}`
  const body = buildCriterionHistoryReportBody(startDate, endDay, `bd_bf_${compact}_${Date.now()}`)
  let tsv: string | null = null
  const MAX_ATTEMPTS = 5
  const MAX_WAIT_SEC = 10
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let poll
    try {
      poll = await pollReport(body)
    } catch (err) {
      console.error('[boris-direct/brain] backfill: сеть упала', err)
      return { backfilledDays: [] }
    }
    if (poll.status === 'ready') {
      tsv = poll.tsv
      break
    }
    if (poll.status === 'failed') {
      console.error(`[boris-direct/brain] backfill: отчёт failed — ${poll.error}`)
      return { backfilledDays: [] }
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(poll.retryInSec, MAX_WAIT_SEC) * 1000))
    }
  }
  if (tsv === null) return { backfilledDays: [] } // всё ещё pending → ретрай на след. тике

  // Разбор: день → CriterionId → агрегат (clicks/conversions suffix-aware/позиция).
  const missingSet = new Set(missing)
  const byDay = new Map<string, Map<number, CriterionDayStatBackfill>>()
  for (const raw of parseReportTsv(tsv)) {
    const day = (raw.Date ?? '').trim()
    if (!missingSet.has(day)) continue // существующие дни не трогаем
    const criterionId = parseCriterionId(raw.CriterionId)
    if (criterionId == null) continue // автотаргет-строки без числового id/пусто — мимо
    const acc = byDay.get(day) ?? new Map<number, CriterionDayStatBackfill>()
    const cur = acc.get(criterionId) ?? { criterionId, clicks: 0, conversions: 0, avgTrafficVolume: 0 }
    cur.clicks += tsvNumber(raw.Clicks)
    cur.conversions += readReportConversions(raw)
    // Date×CriterionId — одна строка на (день, ключ): позиция берётся как есть.
    cur.avgTrafficVolume = tsvNumber(raw.AvgTrafficVolume)
    acc.set(criterionId, cur)
    byDay.set(day, acc)
  }

  // Пишем снапшот на КАЖДЫЙ отсутствующий день (пустой [] у дня без строк — маркер
  // «добрано», чтобы след. тик не передобирал; отчёт за весь диапазон полон).
  const backfilledDays: string[] = []
  for (const day of missing) {
    const acc = byDay.get(day)
    const payload: CriterionDayStatBackfill[] = acc ? [...acc.values()] : []
    try {
      await saveSnapshot(mskDayStartUtc(day), 'query_criterion_daily', payload)
      backfilledDays.push(day)
    } catch (err) {
      console.error(`[boris-direct/brain] backfill: снапшот дня ${day} не записался`, err)
    }
  }
  return { backfilledDays }
}

/** Точный ₽-расход по устройствам (М2): эфемерный device-отчёт Директа
 *  (Device × Clicks/Cost/Conversions за окно). Питает DEVICE_SKEW ТОЧНЫМИ деньгами
 *  вместо оценки по визитам Метрики. Строки без валидного Device отбрасываем (в
 *  полигоне CUSTOM-фейк не отдаёт Device → пусто → §7.5 откатывается на Метрику).
 *  FAIL-SAFE: отчёт не готов/ошибка/сеть → null (вызывающий → фолбэк на оценку). */
async function fetchDeviceReport(
  dateFrom: string,
  dateTo: string
): Promise<Array<{ device: string; clicks: number; costRub: number; conversions: number }> | null> {
  const compact = `${dateFrom.replace(/-/g, '')}_${dateTo.replace(/-/g, '')}`
  const body = buildDeviceReportBody(dateFrom, dateTo, `bd_dev_${compact}_${Date.now()}`)
  const MAX_ATTEMPTS = 4
  const MAX_WAIT_SEC = 8
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let poll
    try {
      poll = await pollReport(body)
    } catch (err) {
      console.error('[boris-direct/brain] device-отчёт: сеть упала', err)
      return null
    }
    if (poll.status === 'ready') {
      const out: Array<{ device: string; clicks: number; costRub: number; conversions: number }> = []
      for (const raw of parseReportTsv(poll.tsv)) {
        const device = (raw.Device ?? '').trim()
        if (!device) continue // нет валидного Device (напр. sim CUSTOM-фейк) → строку мимо
        out.push({
          device,
          clicks: tsvNumber(raw.Clicks),
          costRub: tsvNumber(raw.Cost),
          conversions: readReportConversions(raw),
        })
      }
      return out
    }
    if (poll.status === 'failed') {
      console.error(`[boris-direct/brain] device-отчёт failed — ${poll.error}`)
      return null
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(poll.retryInSec, MAX_WAIT_SEC) * 1000))
    }
  }
  return null
}

// ---------- Тик «сбор» ----------

export interface CollectResult {
  anomalies: Anomaly[]
  requestedReports: string[]
  catastrophe: boolean
}

/** Лимит поллинга отчёта: attempts > лимита → FAILED (отчёт живёт на сервере ~5 часов). */
const MAX_REPORT_ATTEMPTS = 10

export async function runCollectTick(now: Date = new Date()): Promise<CollectResult> {
  const apiErrors: string[] = []
  const requestedReports: string[] = []

  const today = mskDay(now)
  const tickToday = mskDayStartUtc(today)
  const { dateFrom: yesterday } = yesterdayMsk(now)
  const tickYesterday = mskDayStartUtc(yesterday)

  const pushError = (block: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[boris-direct/brain] collect: блок «${block}» упал`, err)
    apiErrors.push(`${block}: ${message}`)
  }

  // 1. Снапшоты текущего состояния (tickDate = сегодня-МСК).
  let campaign: CampaignState | null = null
  let keywords: KeywordRecord[] = []
  try {
    campaign = await getCampaignState()
    await saveSnapshot(tickToday, 'campaign', campaign)
  } catch (err) {
    pushError('campaigns.get', err)
  }
  try {
    keywords = await getKeywords()
    await saveSnapshot(tickToday, 'keywords', keywords)
  } catch (err) {
    pushError('keywords.get', err)
  }
  try {
    const bids = await getKeywordBids()
    await saveSnapshot(tickToday, 'keywordbids', bids)
  } catch (err) {
    pushError('keywordbids.get', err)
  }
  // Объявления (ТОЛЬКО чтение) — снапшот состояния модерации для полигона
  // и точный счёт REJECTED. Сбой ads не роняет тик (ads остаётся null).
  let ads: AdRecord[] | null = null
  try {
    ads = await getAds()
    await saveSnapshot(tickToday, 'ads', ads)
  } catch (err) {
    pushError('ads.get', err)
  }

  // 2. Метрика за вчера (tickDate = МСК-день, за который данные).
  try {
    const goalStats = await getGoalStatsByDay(yesterday, yesterday)
    await saveSnapshot(tickYesterday, 'metrika_goal', goalStats)
  } catch (err) {
    pushError('metrika.goal_by_day', err)
  }

  // 2b. РАЗВЕДОЧНЫЕ СНАПШОТЫ (сессия «Прозрение») — питают глубокую диагностику
  // тика «обработка»: корректировки, группы, расписание + оконные срезы Метрики
  // (устройства/демография/час). Каждый блок независим — сбой одного не роняет
  // тик и не мешает остальным. ТОЛЬКО чтение.
  const DIAG_WINDOW_DAYS = 30
  const windowFrom = mskDay(new Date(now.getTime() - DIAG_WINDOW_DAYS * DAY_MS))
  try {
    await saveSnapshot(tickToday, 'bidmodifiers', await getBidModifiers())
  } catch (err) {
    pushError('bidmodifiers.get', err)
  }
  try {
    await saveSnapshot(tickToday, 'adgroups', await getAdGroups())
  } catch (err) {
    pushError('adgroups.get', err)
  }
  let campaignSettings: CampaignSettings | null = null
  try {
    campaignSettings = await getCampaignSettings()
    await saveSnapshot(tickToday, 'campaign_settings', campaignSettings)
  } catch (err) {
    pushError('campaigns.get(settings)', err)
  }
  // 2c. BACKFILL истории пофразной экономики (self-heal): добираем дни StartDate..вчера,
  // которых нет в query_criterion_daily (Директ хранит историю, снапшоты роли — позже
  // старта кампании). Идемпотентно (существующие дни не трогаем), FAIL-SAFE (ошибка/
  // неготовый отчёт → не добираем, тик живёт; ретрай на след. тике). ТОЛЬКО чтение Reports.
  try {
    const bf = await backfillCriterionHistory(campaignSettings?.StartDate ?? null, yesterday, now)
    if (bf.backfilledDays.length > 0) {
      console.log(`[boris-direct/brain] backfill: добрано дней истории ${bf.backfilledDays.length}`)
    }
  } catch (err) {
    pushError('backfill истории', err)
  }
  try {
    await saveSnapshot(tickToday, 'metrika_device', await getGoalStatsByDevice(windowFrom, yesterday))
  } catch (err) {
    pushError('metrika.device', err)
  }
  try {
    await saveSnapshot(tickToday, 'metrika_demo', await getGoalStatsByDemographics(windowFrom, yesterday))
  } catch (err) {
    pushError('metrika.demographics', err)
  }
  try {
    await saveSnapshot(tickToday, 'metrika_hour', await getGoalStatsByHour(windowFrom, yesterday))
  } catch (err) {
    pushError('metrika.hour', err)
  }
  // М2: пофразное ПОВЕДЕНИЕ (окно, фильтр рекламы) — питает поведенческие
  // минус-кандидаты (предложением) в тике «обработка». Пусто/сбой → блок молчит.
  try {
    await saveSnapshot(tickToday, 'metrika_phrase', await getGoalStatsByPhrase(windowFrom, yesterday))
  } catch (err) {
    pushError('metrika.phrase', err)
  }

  // 3. Заказ двух отчётов за вчера. reportName уникален (метка времени) —
  // требование Reports API. Сразу один шаг поллинга: маленькие отчёты часто
  // готовы с первого POST.
  const dayCompact = yesterday.replace(/-/g, '')
  const stamp = Date.now()
  const reportSpecs = [
    {
      reportName: `bd_sq_${dayCompact}_${stamp}`,
      reportType: 'SEARCH_QUERY_PERFORMANCE_REPORT',
      params: buildSearchQueryReportBody(yesterday, yesterday, `bd_sq_${dayCompact}_${stamp}`),
    },
    {
      reportName: `bd_cp_${dayCompact}_${stamp}`,
      reportType: 'CUSTOM_REPORT',
      params: buildCampaignPerformanceReportBody(yesterday, yesterday, `bd_cp_${dayCompact}_${stamp}`),
    },
  ]
  for (const spec of reportSpecs) {
    try {
      const job = await prisma.borisDirectReportJob.create({
        data: {
          reportName: spec.reportName,
          reportType: spec.reportType,
          dateFrom: yesterday,
          dateTo: yesterday,
          params: JSON.parse(JSON.stringify(spec.params)) as Prisma.InputJsonValue,
        },
      })
      requestedReports.push(spec.reportName)

      const poll = await pollReport(spec.params)
      if (poll.status === 'ready') {
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data: { status: 'READY', tsv: poll.tsv, readyAt: new Date(), attempts: 1 },
        })
      } else if (poll.status === 'failed') {
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', error: poll.error, attempts: 1 },
        })
        apiErrors.push(`report ${spec.reportName}: ${poll.error}`)
      } else {
        // pending: остаётся PENDING — дожмёт тик «обработка» тем же POST.
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data: { attempts: 1 },
        })
      }
    } catch (err) {
      pushError(`report ${spec.reportName}`, err)
    }
  }

  // 4. Аномалии: дневные итоги прошлых дней (снапшоты 'daily_totals' пишет
  // тик «обработка») + тег Метрики + лиды лендинга + отклонения модерации.
  let anomalies: Anomaly[] = []
  try {
    const totals = await loadDailyTotals(tickYesterday, 8) // вчера + 7 предыдущих
    const yesterdayTotals = totals.find((t) => t.date === yesterday) ?? null
    const history = totals.filter((t) => t.date < yesterday)
    const avg = (xs: number[]): number | null =>
      xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null

    // MINOR-2: считаем заявки БЕЗ тестовых (как process/weekly) — иначе тестовая
    // «Тестик» глушит leads_zero (день с 0 реальных + 1 тестовой выглядел как «1»).
    const leadsYesterday = filterOutTestLeads(
      await getLeadsForPeriod(tickYesterday, new Date(tickToday.getTime() - 1))
    ).length
    // М3: средний поток заявок для leads_zero — по РАБОЧИМ дням (B2B живёт по будням;
    // выходные с 0 заявок не должны занижать «норму»). Окно — до дня перед вчера.
    const dayBeforeYesterday = mskDay(new Date(tickYesterday.getTime() - DAY_MS))
    const leadsWindowStart = workdayWindowStartUtc(dayBeforeYesterday, LEADS_ZERO_AVG_WORKDAYS)
    const leadsWindow = filterOutTestLeads(
      await getLeadsForPeriod(leadsWindowStart, new Date(tickYesterday.getTime() - 1))
    ).length

    anomalies = detectAnomalies({
      spentYesterdayRub: yesterdayTotals?.spendRub ?? null,
      avgSpend7dRub: avg(history.map((t) => t.spendRub)),
      impressionsYesterday: yesterdayTotals?.impressions ?? null,
      avgImpressions7d: avg(history.map((t) => t.impressions)),
      addMetricaTag: campaign ? getAddMetricaTagValue(campaign) : null,
      leadsYesterday,
      avgLeads7d: leadsWindow / LEADS_ZERO_AVG_WORKDAYS,
      // REJECTED считаем по объявлениям (ads.get); если чтение ads упало —
      // прежний прокси по фразам, чтобы отказ модерации не потерялся.
      rejectedAdsCount: ads
        ? ads.filter((a) => a.Status === 'REJECTED').length
        : keywords.filter((k) => k.Status === 'REJECTED').length,
      apiErrors,
      // B2B-сезонность: обрыв показов/ноль заявок в выходной — не аномалия.
      yesterdayIsWeekend: isWeekend(yesterday),
    })
  } catch (err) {
    pushError('anomalies', err)
    anomalies = [
      { severity: 'warn', kind: 'api_errors', text: `Ошибки тика «сбор»: ${apiErrors.join('; ')}` },
    ]
  }

  // 5. Катастрофа расхода «сегодня»: дёшево не достать — отчёт за текущий
  // день не заказываем (медленно и неточно). Каркас: когда появится дешёвый
  // источник расхода за сегодня, сюда встаёт
  //   isCatastrophe({ spentTodayRub, dailyBudgetRub: DAILY_BUDGET_MICRO / MICRO })
  // и при true — suspendCampaignEmergency + сообщение владельцу (шлёт вызывающий).
  // TODO(brain): подключить источник расхода за сегодня.
  const catastrophe = false

  return { anomalies, requestedReports, catastrophe }
}

// ---------- Тик «обработка» ----------

export interface ProposalDraft {
  type: string
  topicKey: string
  payload: unknown
  argument: string
  question: string
  triggerMetric?: string
  triggerValue?: number
}

export interface MinusVerdictDraft {
  candidate: string
  verdict: 'minus' | 'keep'
  reason: string
}

export interface DailyReportData {
  dateLabel: string
  spendRub: number | null
  clicks: number | null
  impressions: number | null
  ctr: number | null
  leadsTotal: number
  leadsFromDirect: number
  costPerLeadRub: number | null
  topQueries: Array<{ query: string; clicks: number; costRub: number; conversions: number }>
  quarantine: boolean
  /** М3: расход vs живой бюджет + состояние гейта маржинального подъёма. */
  underspend?: {
    spentYesterdayRub: number | null
    dailyBudgetRub: number
    gateOpen: boolean
    medianRub: number | null
  }
  /**
   * М3.5: ввод портфеля порциями (ramp-in). Заполнено, когда план правок ставок
   * не влез в CB целиком и применено подмножество; остаток догоняется на
   * следующих тиках. deferred=0 → строку не показываем (штатный тик).
   */
  portfolioRampIn?: {
    applied: number
    planned: number
    deferred: number
  }
  llm?: never
}

/** Экспорт уже вычисляемой атрибуции лида (эмиссия фазы 0, не новая логика). */
export interface LeadAttributionRecord {
  /** `${phoneDigits ?? 'x'}@${МСК-день createdAt}` — стабильный ключ лида. */
  leadKey: string
  adGroupId: string | null
  query: string | null
  matchedBy: 'utm_term' | 'yclid_only' | 'none'
}

export interface ProcessResult {
  status: 'waiting_report' | 'done' | 'quarantine'
  appliedSummaries: string[]
  wouldDoSummaries: string[]
  proposalDrafts: ProposalDraft[]
  verdicts: MinusVerdictDraft[]
  reportData: DailyReportData | null
  anomalies: Anomaly[]
  /**
   * Машинные записи УЖЕ принятых решений тика (эмиссия для полигона фазы 0).
   * Только done/quarantine — waiting_report решений не принимает.
   */
  decisions?: DecisionRecord[]
  /** Атрибуция лидов за вчера — экспорт splitLeadsByOrigin/matchLeadsToTerms. */
  attribution?: LeadAttributionRecord[]
  /** Итоги памяти-хуков (только для done/quarantine; waiting_report их не запускает). */
  memory?: {
    outcomesMeasured: number
    lessons?: { created: number; confirmed: number; refuted: number; staled: number }
  }
}

/** Число из ячейки TSV Директа: '--', пустота, мусор → 0. */
function tsvNumber(raw: string | undefined): number {
  const v = raw?.trim()
  if (!v || v === '--') return 0
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/** Ответ LLM-классификатора структурного мусора в минусовке. */
interface ClassifiedCandidate {
  candidate: string
  structural: boolean
  confident: boolean
  reason: string
}

/**
 * Парсит СТРОГО-JSON ответ классификатора. Мусорный/битый ответ → пустой
 * массив (все кандидаты считаются спорными — безопасное направление ошибки).
 */
function parseClassifierJson(text: string, candidates: string[]): ClassifiedCandidate[] {
  try {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end <= start) return []
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const allowed = new Set(candidates)
    const result: ClassifiedCandidate[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (
        typeof row.candidate !== 'string' ||
        !allowed.has(row.candidate) ||
        typeof row.structural !== 'boolean' ||
        typeof row.confident !== 'boolean'
      ) {
        continue
      }
      result.push({
        candidate: row.candidate,
        structural: row.structural,
        confident: row.confident,
        reason: typeof row.reason === 'string' ? row.reason : '',
      })
    }
    return result
  } catch {
    return []
  }
}

/** Последний готовый (READY/PROCESSED) отчёт нужного типа за день. */
async function findReadyJob(reportType: string, day: string) {
  return prisma.borisDirectReportJob.findFirst({
    where: { reportType, dateFrom: day, dateTo: day, status: { in: ['READY', 'PROCESSED'] } },
    orderBy: { requestedAt: 'desc' },
  })
}

/**
 * Память-хуки после полного тика (пути done/quarantine, НЕ waiting_report):
 * замер исходов действий и предложений — каждый день; по понедельникам МСК —
 * дистилляция уроков + коррекционные предложения (сами no-op при выключенном
 * флаге). Каждый вызов в try/catch — память никогда не роняет тик.
 */
async function runMemoryHooks(now: Date): Promise<NonNullable<ProcessResult['memory']>> {
  let outcomesMeasured = 0
  try {
    outcomesMeasured += (await measureActionOutcomes(now)).measured
  } catch (err) {
    console.error('[boris-direct/brain] memory: measureActionOutcomes упал', err)
  }
  try {
    outcomesMeasured += (await measureProposalOutcomes(now)).measured
  } catch (err) {
    console.error('[boris-direct/brain] memory: measureProposalOutcomes упал', err)
  }

  const memory: NonNullable<ProcessResult['memory']> = { outcomesMeasured }

  if (isMondayMsk(now)) {
    try {
      memory.lessons = await deriveAndRefreshLessons(now)
    } catch (err) {
      console.error('[boris-direct/brain] memory: deriveAndRefreshLessons упал', err)
    }
    try {
      await generateCorrectionProposals(now)
    } catch (err) {
      console.error('[boris-direct/brain] memory: generateCorrectionProposals упал', err)
    }
  }

  return memory
}

export async function runProcessTick(now: Date = new Date()): Promise<ProcessResult> {
  const anomalies: Anomaly[] = []
  const appliedSummaries: string[] = []
  const wouldDoSummaries: string[] = []
  const proposalDrafts: ProposalDraft[] = []
  const verdicts: MinusVerdictDraft[] = []
  // ЭМИССИЯ (фаза 0): машинные записи уже принятых решений. Наполнение НЕ
  // меняет ни одно решение — только делает его видимым полигону.
  const decisions: DecisionRecord[] = []
  let attribution: LeadAttributionRecord[] | undefined

  const { dateFrom: yesterday } = yesterdayMsk(now)
  const dayStart = mskDayStartUtc(yesterday)
  const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1)

  const pushBlockError = (block: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[boris-direct/brain] process: блок «${block}» упал`, err)
    anomalies.push({ severity: 'warn', kind: 'process_block_error', text: `блок «${block}»: ${message}` })
  }

  /** Каждая аномалия результата → alert ANOMALY_ALERT (перед самым return).
   * circuit_breaker пропускаем — он уже эмитирован собственным кодом. */
  const emitAnomalyAlerts = () => {
    for (const anomaly of anomalies) {
      if (anomaly.kind === 'circuit_breaker') continue
      // Сверка потери заявки — мониторинговый алёрт (уходит владельцу через тик),
      // НЕ сигнал оптимизации кампании: в полигон-решения не эмитим, чтобы не
      // трогать sim-базлайн.
      if (anomaly.kind === 'lead_reconcile_loss') continue
      decisions.push({
        type: 'alert',
        targetType: 'campaign',
        targetId: String(DIRECT_CAMPAIGN_ID),
        summary: anomaly.text,
        reasonCode: 'ANOMALY_ALERT',
        factors: { kind: anomaly.kind },
      })
    }
  }

  // 1. Дожать PENDING-отчёты: повтор ТОГО ЖЕ POST (params из БД).
  try {
    const pendingJobs = await prisma.borisDirectReportJob.findMany({ where: { status: 'PENDING' } })
    for (const job of pendingJobs) {
      const poll = await pollReport(job.params)
      if (poll.status === 'ready') {
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data: { status: 'READY', tsv: poll.tsv, readyAt: new Date(), attempts: job.attempts + 1 },
        })
      } else if (poll.status === 'failed') {
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', error: poll.error, attempts: job.attempts + 1 },
        })
      } else {
        const attempts = job.attempts + 1
        await prisma.borisDirectReportJob.update({
          where: { id: job.id },
          data:
            attempts > MAX_REPORT_ATTEMPTS
              ? { status: 'FAILED', error: 'превышен лимит поллинга', attempts }
              : { attempts },
        })
      }
    }
  } catch (err) {
    pushBlockError('поллинг отчётов', err)
  }

  // 2. Оба отчёта за вчера должны быть готовы — иначе ждём следующего тика.
  const sqJob = await findReadyJob('SEARCH_QUERY_PERFORMANCE_REPORT', yesterday)
  const cpJob = await findReadyJob('CUSTOM_REPORT', yesterday)
  if (!sqJob?.tsv || !cpJob?.tsv) {
    return {
      status: 'waiting_report',
      appliedSummaries,
      wouldDoSummaries,
      proposalDrafts,
      verdicts,
      reportData: null,
      anomalies,
    }
  }

  // 3. Разбор отчётов + дневные итоги.
  const rows: QueryStatRow[] = parseReportTsv(sqJob.tsv).map(toQueryStatRow)
  const cpRows = parseReportTsv(cpJob.tsv)
  const spendRub = cpRows.reduce((acc, r) => acc + tsvNumber(r.Cost), 0)
  const clicks = cpRows.reduce((acc, r) => acc + tsvNumber(r.Clicks), 0)
  const impressions = cpRows.reduce((acc, r) => acc + tsvNumber(r.Impressions), 0)
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null

  // Построчная статистика запросов → BorisDirectQueryDailyStat (сырьё для
  // памяти-опыта: из неё считаются уроки и замер исходов). date — вчера-МСК,
  // тем же способом, что и у снапшотов. Ошибка персиста НЕ роняет тик.
  try {
    for (const row of rows) {
      await prisma.borisDirectQueryDailyStat.upsert({
        where: {
          date_query_adGroupId: { date: dayStart, query: row.query, adGroupId: row.adGroupId },
        },
        update: {
          adGroupName: row.adGroupName,
          impressions: row.impressions,
          clicks: row.clicks,
          costRub: row.costRub,
          conversions: row.conversions,
        },
        create: {
          date: dayStart,
          query: row.query,
          adGroupId: row.adGroupId,
          adGroupName: row.adGroupName,
          impressions: row.impressions,
          clicks: row.clicks,
          costRub: row.costRub,
          conversions: row.conversions,
        },
      })
    }
  } catch (err) {
    console.error('[boris-direct/brain] персист BorisDirectQueryDailyStat упал — день не сохранён', err)
  }

  // MAJOR-2: ID-снапшот дня для пофразной экономики — агрегат вчерашних SQ-строк
  // по CriterionId (id ключа, на который Директ сматчил запрос). Из этих снапшотов
  // §7 собирает окно 14/30 дн ПО КЛЮЧУ (а не по тексту запроса). Строки без
  // числового CriterionId (автотаргет/пусто) не пишем — в пофразный биддинг не идут.
  try {
    const byCriterion = new Map<number, { clicks: number; conversions: number }>()
    for (const row of rows) {
      if (row.criterionId == null) continue
      const cur = byCriterion.get(row.criterionId) ?? { clicks: 0, conversions: 0 }
      cur.clicks += row.clicks
      cur.conversions += row.conversions
      byCriterion.set(row.criterionId, cur)
    }
    const payload: CriterionDayStat[] = [...byCriterion.entries()].map(([criterionId, s]) => ({
      criterionId,
      clicks: s.clicks,
      conversions: s.conversions,
    }))
    await saveSnapshot(dayStart, 'query_criterion_daily', payload)
  } catch (err) {
    console.error('[boris-direct/brain] снапшот query_criterion_daily не записался', err)
  }

  try {
    // Итоги дня — для аномалий на следующих тиках «сбор».
    await saveSnapshot(dayStart, 'daily_totals', {
      date: yesterday,
      spendRub,
      clicks,
      impressions,
    } satisfies DailyTotals)
  } catch (err) {
    pushBlockError('снапшот daily_totals', err)
  }

  // 4. Лиды за вчера и цена заявки (вся арифметика — код).
  let leadsTotal = 0
  let leadsFromDirect = 0
  let costPerLeadRub: number | null = null
  try {
    // ШАГ 3в: тестовые заявки (маркеры test-markers) вне счёта и конвертер-логики.
    const leads = filterOutTestLeads(await getLeadsForPeriod(dayStart, dayEnd))
    const split = splitLeadsByOrigin(leads)
    leadsTotal = leads.length
    leadsFromDirect = split.fromDirect.length
    costPerLeadRub = computeCostPerLead(spendRub, leadsFromDirect)

    // ЭМИССИЯ: экспорт уже вычисляемого сопоставления лид↔запрос — тот же
    // matchLeadsToTerms по Директ-лидам, новой логики атрибуции нет.
    // adGroupId — из строки отчёта с совпавшим запросом (первое вхождение,
    // как в matchLeadsToTerms).
    const adGroupByQuery = new Map<string, string>()
    for (const row of rows) {
      if (!adGroupByQuery.has(row.query)) adGroupByQuery.set(row.query, row.adGroupId)
    }
    const matchByLeadId = new Map(
      matchLeadsToTerms(split.fromDirect, rows).map((m) => [m.lead.id, m])
    )
    attribution = leads.map((lead): LeadAttributionRecord => {
      const matchedQuery = matchByLeadId.get(lead.id)?.matchedQuery ?? null
      const hasYclid = Boolean(lead.yclid && lead.yclid.trim() !== '')
      return {
        leadKey: `${lead.phoneDigits ?? 'x'}@${mskDay(lead.createdAt)}`,
        adGroupId: matchedQuery !== null ? (adGroupByQuery.get(matchedQuery) ?? null) : null,
        query: matchedQuery,
        matchedBy: matchedQuery !== null ? 'utm_term' : hasYclid ? 'yclid_only' : 'none',
      }
    })
  } catch (err) {
    pushBlockError('лиды', err)
  }

  // 4b. ДИАГНОСТИКА (виток 2): сверка источников заявок. Отчёт Директа (конверсии
  // по клику), Метрика (цель) и БД лидов должны примерно сходиться. Резкое
  // расхождение = битые данные (слетела разметка / вал пустышек): первопричина
  // не в трафике — флагаем, чтобы не награждать фразы и не резать по ложному
  // сигналу. Только ЭМИССИЯ диагноза, действий не меняет.
  try {
    const reportConv = rows.reduce((acc, r) => acc + r.conversions, 0)
    // MINOR-3: Метрику берём ПРИВЯЗАННОЙ к тому же дню (dayStart), а НЕ latest —
    // протухший снапшот другого дня (вчера Метрика не отдалась) давал ложный
    // DATA_MISMATCH. Один фетч на оба гейта. Нет снапшота за день → Метрику из
    // сравнения ИСКЛЮЧАЕМ (отсутствие данных ≠ расхождение).
    const metrikaGoalDay = await snapshotPayloadForDay<Array<{ goalReaches?: number }>>(
      'metrika_goal',
      dayStart
    )
    const metrikaGoal = metrikaGoalDay?.reduce((acc, g) => acc + (g.goalReaches ?? 0), 0) ?? 0
    const counts = [reportConv, ...(metrikaGoalDay ? [metrikaGoal] : []), leadsTotal].filter((c) =>
      Number.isFinite(c)
    )
    const maxC = Math.max(...counts)
    const minC = Math.min(...counts)
    if (maxC >= DATA_MISMATCH_MIN_COUNT && maxC >= minC * DATA_MISMATCH_RATIO) {
      decisions.push({
        type: 'diagnosis',
        targetType: 'campaign',
        targetId: String(DIRECT_CAMPAIGN_ID),
        summary: `источники заявок расходятся: отчёт ${reportConv}, Метрика ${metrikaGoalDay ? metrikaGoal : 'н/д'}, БД ${leadsTotal} — первопричина в данных, не в трафике`,
        reasonCode: 'DATA_MISMATCH',
        // Метрика отсутствует за день → 'н/д' (а не 0): телеметрия честно отражает
        // «данных нет» (в сравнение Метрика в этом случае и не входила).
        factors: { reportConv, metrikaGoal: metrikaGoalDay ? metrikaGoal : 'н/д', leadsTotal },
      })
    }

    // ШАГ 3: общий гейт DATA_MISMATCH (MIN_COUNT=3) прячет потерю ОДНОЙ заявки.
    // Чувствительная сверка «конверсии Метрики (цель 575665118) vs заявки в БД»,
    // порог 1. Эмитим АНОМАЛИЮ — она дойдёт до владельца через тик (в отличие от
    // decision, который в чат не идёт). Прочие пороги не трогаем. Метрика — тот же
    // day-bound снапшот, что и в гейте выше (нет за день → не сверяем).
    // ОГРАНИЧЕНИЕ: goalReaches и заявки в БД имеют разные слепые зоны (adblock
    // занижает цели, сбой persist занижает записи), поэтому одиночная потеря может
    // быть замаскирована одиночным adblock-лидом. Основной сигнал одиночной потери —
    // алёрт [INTAKE] в реальном времени при сбое persist; эта сверка — доп. бэкстоп.
    if (metrikaGoalDay) {
      // ШАГ 3б (фантом-правило): достижения ДО фикса фронта (b669b35, 05.07)
      // могли сработать на неуспешной отправке. Для этой сверки вес 0 (день
      // целиком под подозрением), чтобы пре-фикс-фантомы не давали ложный
      // [СВЕРКА]. Дни ≥ фикса весят 1 → штатная работа/полигон не меняются.
      const metrikaGoalYesterday = phantomWeight(yesterday) * metrikaGoal
      const reconcileLoss = detectLeadReconcileLoss({
        reportConv,
        metrikaGoal: metrikaGoalYesterday,
        leadsTotal,
      })
      if (reconcileLoss) anomalies.push(reconcileLoss)
    }
  } catch (err) {
    pushBlockError('сверка источников', err)
  }

  // 5. Карантин на РЕАЛЬНЫХ входах: возраст = (МСК-сегодня − StartDate кампании),
  // клики = истинный кумулятив из Reports (StartDate → вчера). НЕ число снапшот-
  // тиков и НЕ Σ локальных daily_totals — иначе гейт слеп к дням до старта сбора.
  // StartDate берём из campaign_settings-снапшота (пишется каждый тик — нового
  // вызова БД/API под это не нужно). FAIL-SAFE в decideQuarantine: нет StartDate
  // или кумулятив не получен → карантин.
  let quarantine = false
  // Цифры, на которые опёрся карантин, — для машинной записи (эмиссия).
  let quarantineFactors: Record<string, number | string> = {}
  try {
    const settings = await latestSnapshotPayload<CampaignSettings>('campaign_settings')
    const startDate = settings?.StartDate ?? null
    const cumulativeClicks = await fetchCumulativeCampaignClicks(startDate, yesterday)
    const decided = decideQuarantine({ startDate, todayMsk: mskDay(now), cumulativeClicks })
    quarantine = decided.quarantine
    quarantineFactors = decided.factors
  } catch (err) {
    pushBlockError('карантин', err)
    quarantine = true // не смогли посчитать → безопаснее не оптимизировать
    quarantineFactors = { note: 'ошибка расчёта — карантин из осторожности' }
  }

  const markProcessed = async () => {
    await prisma.borisDirectReportJob.updateMany({
      where: { id: { in: [sqJob.id, cpJob.id] } },
      data: { status: 'PROCESSED', processedAt: new Date() },
    })
  }

  const topQueries = [...rows]
    .sort((a, b) => b.clicks - a.clicks || b.costRub - a.costRub)
    .slice(0, 5)
    .map((r) => ({ query: r.query, clicks: r.clicks, costRub: r.costRub, conversions: r.conversions }))

  // М3: ГЕЙТ НЕДОРАСХОДА — считаем ОДИН раз здесь (используется §7-маржиналом и
  // отчётом). DailyBudget — из ЖИВОГО снапшота кампании. Окно — рабочие дни.
  let underspendGate: UnderspendGate = { open: false, medianRub: null, reason: 'не считался' }
  let dailyBudgetRub = 0
  try {
    const liveCampaign = await latestSnapshotPayload<CampaignState>('campaign')
    dailyBudgetRub = (liveCampaign?.DailyBudget?.Amount ?? 0) / MICRO
    const spendWindow = await loadDailyTotals(dayStart, UNDERSPEND_WINDOW_WORKDAYS * 2 + 3)
    const workdaySpends = spendWindow.filter((t) => isWorkday(t.date))
    const recent = workdaySpends.slice(-UNDERSPEND_WINDOW_WORKDAYS).map((t) => t.spendRub)
    const yTotals = spendWindow.find((t) => t.date === yesterday)
    // Гистерезис: прошлое состояние гейта (снапшот) — иначе петля «газ↔тормоз» осциллирует.
    const prevGate = await latestSnapshotPayload<{ open: boolean }>('underspend_gate')
    underspendGate = underspendGateOpen({
      recentDailySpendsRub: recent,
      yesterdaySpendRub: yTotals?.spendRub ?? null,
      dailyBudgetRub,
      previouslyOpen: prevGate?.open ?? false,
    })
    // Пишем новое состояние для гистерезиса следующего тика (ошибка записи не критична).
    try {
      await saveSnapshot(dayStart, 'underspend_gate', { open: underspendGate.open })
    } catch (err) {
      console.error('[boris-direct/brain] снапшот underspend_gate не записался', err)
    }
  } catch (err) {
    console.error('[boris-direct/brain] гейт недорасхода не посчитан — маржинал молчит', err)
  }

  const reportData: DailyReportData = {
    dateLabel: yesterday,
    spendRub,
    clicks,
    impressions,
    ctr,
    leadsTotal,
    leadsFromDirect,
    costPerLeadRub,
    topQueries,
    quarantine,
    underspend: {
      spentYesterdayRub: spendRub,
      dailyBudgetRub,
      gateOpen: underspendGate.open,
      medianRub: underspendGate.medianRub,
    },
  }

  if (quarantine) {
    // В карантине НЕ оптимизируем: только честный отчёт «наблюдаю».
    // Память при этом копится — исходы и уроки меряем и здесь.
    // ЭМИССИЯ: одна машинная запись «держимся» уровня кампании.
    decisions.push({
      type: 'hold',
      targetType: 'campaign',
      targetId: String(DIRECT_CAMPAIGN_ID),
      summary: 'карантин молодой кампании — только наблюдаем, не оптимизируем',
      reasonCode: 'QUARANTINE_HOLD',
      factors: quarantineFactors,
    })
    await markProcessed()
    const memory = await runMemoryHooks(now)
    emitAnomalyAlerts()
    return {
      status: 'quarantine',
      appliedSummaries,
      wouldDoSummaries,
      proposalDrafts,
      verdicts,
      reportData,
      anomalies,
      decisions,
      attribution,
      memory,
    }
  }

  const state = await getDirectRoleState()

  // ЭКОНОМИЧЕСКАЯ КОНСТИТУЦИЯ (ШАГ 6): защита конвертеров по окну 30 дней ДЛЯ
  // МИНУСА — по ТЕКСТУ запроса (минус кампейн-левел, оперирует текстами). Защита
  // конвертеров для СТАВОК (§7) считается ОТДЕЛЬНО по CriterionId (loadCriterionWindow),
  // т.к. заявка приписана КЛЮЧУ, на который сматчился запрос, а не тексту.
  const conv30dByQueryText = new Map<string, number>()
  try {
    // М3: окно защиты конвертеров МИНУСА (по тексту) в РАБОЧИХ днях.
    const convWindowStart = workdayWindowStartUtc(mskDay(dayStart), CONVERTER_PROTECT_WINDOW_WORKDAYS)
    const stats30 = await prisma.borisDirectQueryDailyStat.findMany({
      where: { date: { gte: convWindowStart, lte: dayStart } },
    })
    for (const s of stats30) {
      const nq = normQueryKey(s.query)
      conv30dByQueryText.set(nq, (conv30dByQueryText.get(nq) ?? 0) + s.conversions)
    }
  } catch (err) {
    console.error('[boris-direct/brain] окно защиты конвертеров (30д) недоступно', err)
  }

  // 6. МИНУСА: data-driven кандидаты → механика/ядро/дедуп → LLM-классификатор
  // структурного мусора → автономно ИЛИ предложение владельцу.
  //
  // ОКНО (виток 6): кандидаты берём по НАКОПЛЕННЫМ за окно показам, а не за один
  // вчерашний день. Низкообъёмный, но стабильный мусор (10 показов/день ×
  // 21 день = 210) виден в СУММЕ, но не пробивает дневной порог 30 — раньше
  // Борис его не резал и оракул фиксировал слив. Fallback на вчерашний отчёт,
  // если истории окна нет (молодая кампания).
  try {
    let minusRows: QueryStatRow[] = rows
    try {
      // М3: окно накопленных показов для минус-кандидатов в РАБОЧИХ днях.
      const windowStartMinus = workdayWindowStartUtc(mskDay(dayStart), PHRASE_ECON_WINDOW_WORKDAYS)
      const ws = await prisma.borisDirectQueryDailyStat.findMany({
        where: { date: { gte: windowStartMinus, lte: dayStart } },
      })
      if (ws.length > 0) {
        // Агрегат по ТЕКСТУ запроса (минус — кампейн-левел, группа не важна).
        const agg = new Map<string, QueryStatRow>()
        for (const s of ws) {
          const cur = agg.get(s.query) ?? {
            query: s.query,
            adGroupName: s.adGroupName ?? '',
            adGroupId: s.adGroupId,
            // Минус работает по тексту запроса; CriterionId тут не нужен (агрегат
            // по тексту из накопленного DailyStat, где id ключа не хранится).
            criterionId: null,
            impressions: 0,
            clicks: 0,
            costRub: 0,
            conversions: 0,
          }
          cur.impressions += s.impressions
          cur.clicks += s.clicks
          cur.costRub += Number(s.costRub)
          cur.conversions += s.conversions
          agg.set(s.query, cur)
        }
        minusRows = [...agg.values()]
      }
    } catch (err) {
      console.error('[boris-direct/brain] окно минусовки недоступно — вчерашний отчёт', err)
    }
    const candidatesRaw = pickDataDrivenMinusCandidates(minusRows)
    // ЭКОНОМИЧЕСКАЯ КОНСТИТУЦИЯ (ШАГ 6a): защищённые конвертеры (≥1 заявка за
    // 30д) НЕ минусуем, даже если в узком окне минуса заявок 0 — только
    // наблюдаем. Отсекаем ТОЛЬКО объём-без-конверсий (цена клика — не критерий).
    const { kept: candidates, protectedConverters } = filterOutProtectedConverters(
      candidatesRaw,
      // ШАГ 3а: подтверждённый владельцем конвертер защищён независимо от 30д-статистики
      // (историческая статистика была занижена багом суффиксной колонки конверсий).
      (q) => Math.max(conv30dByQueryText.get(normQueryKey(q)) ?? 0, isRegisteredConverter(q) ? 1 : 0)
    )
    if (protectedConverters.length > 0) {
      decisions.push({
        type: 'hold',
        targetType: 'query',
        targetId: protectedConverters.slice(0, 20).join(', '),
        summary: `защита конвертеров: ${protectedConverters.length} фраз с заявками за 30д — не минусую, наблюдаю`,
        reasonCode: 'PROVEN_CONVERTER_VOLUME',
        factors: { protectedCount: protectedConverters.length },
      })
    }
    if (candidates.length > 0) {
      const keywordsSnap = (await latestSnapshotPayload<KeywordRecord[]>('keywords')) ?? []
      const coreKeywords = keywordsSnap.map((k) => k.Keyword)

      // existingMinus пустой ЗДЕСЬ сознательно: финальный дедуп против ЖИВОГО
      // списка кабинета и мерж с ним делает единая точка addNegativeKeywords
      // (свежий campaigns.get в момент применения) — тут только отбор кандидатов.
      const prepared = prepareMinusCandidates(candidates, { coreKeywords, existingMinus: [] })

      const statByQuery = new Map(minusRows.map((r) => [r.query, r]))

      // LLM (light) — ТОЛЬКО суждение «структурный мусор или нет», никаких чисел.
      let classified: ClassifiedCandidate[] = []
      if (prepared.accepted.length > 0) {
        try {
          // Справочная доктрина (механика минус-фраз/операторов/автотаргетинга) —
          // справка, НЕ приказ (преамбула внутри блока). Помогает классификатору
          // не путать механику; на код-пороги не влияет.
          const minusDoctrine = getDoctrineBlock(
            ['negative-keywords', 'match-operators', 'keywords', 'autotargeting'],
            { maxItems: 6, maxTokens: 700 }
          )
          const system =
            getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen }) +
            `\n\nЗАДАЧА КЛАССИФИКАТОРА: для каждого кандидата в минус-фразы реши, СТРУКТУРНЫЙ ли это мусор для нашего бизнеса (доставка обедов на коллективы). Мусор: чужое кафе/бренд/навигация к конкуренту; запросы не про доставку обедов на коллектив (вакансии, рецепты, розница на одного); запросы ДРУГИХ регионов. ГЕО: зона доставки — Москва и ВСЯ Московская область (регионы 213+1). Города МО (например Электросталь, Балашиха, Химки, Подольск, Мытищи, Королёв) — ЦЕЛЕВЫЕ, это НЕ мусор. Мусор по гео — только запросы про регионы ВНЕ Москвы и МО (например Благовещенск, Элиста, Санкт-Петербург, Екатеринбург). Верни СТРОГО JSON-массив без пояснений и без markdown: [{"candidate": string, "structural": boolean, "confident": boolean, "reason": string}]. confident=true только если сомнений нет.` +
            (minusDoctrine ? `\n\n${minusDoctrine}` : '')
          const llmResult = await callBorisDirectLlm({
            purpose: 'minus_classify',
            tier: 'light',
            system,
            userText: JSON.stringify(
              prepared.accepted.map((phrase) => {
                const stat = statByQuery.get(phrase)
                return {
                  candidate: phrase,
                  impressions: stat?.impressions ?? 0,
                  clicks: stat?.clicks ?? 0,
                  conversions: stat?.conversions ?? 0,
                }
              })
            ),
            maxTokens: 1024,
          })
          classified = parseClassifierJson(llmResult.text, prepared.accepted)
        } catch (err) {
          // LLM упал/мусор → classified пуст → все кандидаты спорные.
          console.error('[boris-direct/brain] minus_classify упал — все кандидаты спорные', err)
          classified = []
        }
      }

      const verdictByCandidate = new Map(classified.map((c) => [c.candidate, c]))
      const autonomous: string[] = []
      const disputed: string[] = []
      // Цифры кандидата (показы/клики/конверсии) — факторы машинной записи.
      const statFactors = (phrase: string): Record<string, number> => {
        const stat = statByQuery.get(phrase)
        return {
          impressions: stat?.impressions ?? 0,
          clicks: stat?.clicks ?? 0,
          conversions: stat?.conversions ?? 0,
        }
      }
      // Коды автономной пачки — для префикса reason в write-gate (дубль в лог).
      const autonomousCodes = new Set<ReasonCode>()
      for (const phrase of prepared.accepted) {
        const cls = verdictByCandidate.get(phrase)
        // ГЕО-суждение (зона доставки = Москва+МО, регионы 213+1):
        //  • out_of_zone (Благовещенск/Элиста/другой регион) → структурный мусор
        //    ДЕТЕРМИНИРОВАННО, не ждём уверенности LLM;
        //  • in_zone (города МО: Электросталь и т.п.) — ЦЕЛЕВЫЕ: гео-мотивный
        //    LLM-минус на них перехватываем и уводим владельцу (не авто-режем цель).
        const geoZone = classifyQueryGeo(phrase)
        const geoTrash = geoZone === 'out_of_zone'
        const geoProtected =
          geoZone === 'in_zone' && !!cls?.structural && isGeoMinusReason(cls.reason)

        if (!geoProtected && (geoTrash || (cls && cls.structural && cls.confident))) {
          autonomous.push(phrase)
          const reason = geoTrash ? 'вне зоны доставки (не Москва/МО)' : cls?.reason || 'структурный мусор'
          verdicts.push({ candidate: phrase, verdict: 'minus', reason })
          // ЭМИССИЯ: автономный минус — структурный мусор (LLM-уверенный ИЛИ вне-гео).
          autonomousCodes.add('STRUCTURAL_TRASH')
          decisions.push({
            type: 'minus',
            targetType: 'query',
            targetId: phrase,
            summary: reason,
            reasonCode: 'STRUCTURAL_TRASH',
            factors: statFactors(phrase),
          })
        } else if (!geoProtected && state.autoNegativesEnabled) {
          // Гейт спорных минусов снят обучением — спорные тоже в автономию.
          autonomous.push(phrase)
          verdicts.push({
            candidate: phrase,
            verdict: 'minus',
            reason: cls?.reason || 'гейт снят обучением — спорный кандидат в автономию',
          })
          // ЭМИССИЯ: автономный минус из data-порога (показы ≥ порога, 0 конверсий).
          autonomousCodes.add('DATA_NO_CONV')
          decisions.push({
            type: 'minus',
            targetType: 'query',
            targetId: phrase,
            summary: 'data-порог: показы без конверсий (гейт снят обучением)',
            reasonCode: 'DATA_NO_CONV',
            factors: statFactors(phrase),
          })
        } else {
          disputed.push(phrase)
          verdicts.push({
            candidate: phrase,
            verdict: geoProtected ? 'keep' : cls?.structural ? 'minus' : 'keep',
            reason: geoProtected
              ? `город МО — целевой, гео-минус на решение владельца${cls?.reason ? ` (${cls.reason})` : ''}`
              : cls?.reason || 'классификатор не дал уверенного вердикта — решает владелец',
          })
          // ЭМИССИЯ: спорный кандидат (в т.ч. защита целевого города МО) — владельцу.
          decisions.push({
            type: 'proposal',
            targetType: 'query',
            targetId: phrase,
            summary: geoProtected
              ? 'гео-минус целевого города МО — на решение владельца'
              : 'спорный минус — предложение владельцу',
            reasonCode: 'DISPUTED_MINUS',
            factors: statFactors(phrase),
          })
        }
      }

      if (autonomous.length > 0) {
        // ЕДИНАЯ ТОЧКА: addNegativeKeywords сам читает СВЕЖИЙ живой список кабинета
        // и шлёт ОБЪЕДИНЕНИЕ (живой + новые) — замещающий список строится поверх
        // реального содержимого, а не из голых новых фраз (иначе кабинет затрётся).
        // Fail-safe (нет чтения / подозрительное усыхание) → отмена + аномалия.
        // Префикс машинного кода в reason — дубль записи в payload лога действий.
        const negativesCodePrefix = (['STRUCTURAL_TRASH', 'DATA_NO_CONV'] as const)
          .filter((code) => autonomousCodes.has(code))
          .join(',')
        const gate = await addNegativeKeywords(
          autonomous,
          `[${negativesCodePrefix}] минусовка: ${autonomous.length} структурных кандидатов (показы ≥ порога, конверсий 0): ${autonomous.join(', ')}`
        )
        const summary = `минус-фразы (${autonomous.length}): ${autonomous.join(', ')}`
        if (gate.aborted) {
          anomalies.push({
            severity: 'critical',
            kind: 'negatives_failsafe',
            text: `Автономная минусовка ОТМЕНЕНА (fail-safe): ${gate.abortReason}. Живой список кабинета не тронут.`,
          })
        } else if (gate.writeErrors?.length) {
          // A: campaigns.update вернул HTTP 200 с Errors → write НЕ прошёл. Не молчим
          // (иначе фантом «применено»): критическая аномалия с кодами ошибок дословно,
          // в applied/«сделал бы» НЕ пишем.
          anomalies.push({
            severity: 'critical',
            kind: 'negatives_write_fail',
            text: `Автономная минусовка НЕ применилась в Директе (ошибки API): ${gate.writeErrors.join('; ')}. Список кабинета не тронут.`,
          })
        } else {
          if (gate.verifyMismatch) {
            anomalies.push({
              severity: 'critical',
              kind: 'negatives_verify_mismatch',
              text: 'Минус-фразы применены, но контрольное чтение кабинета не сошлось — проверь список минус-фраз вручную.',
            })
          }
          if (gate.applied) appliedSummaries.push(summary)
          else wouldDoSummaries.push(summary)
        }
      }

      if (disputed.length > 0) {
        const disputedVerdicts = verdicts.filter((v) => disputed.includes(v.candidate))
        const argumentParts = disputed.map((phrase) => {
          const stat = statByQuery.get(phrase)
          return `«${phrase}» — ${stat?.impressions ?? 0} показов, ${stat?.clicks ?? 0} кликов, 0 заявок`
        })
        const triggerValue = disputed.reduce(
          (acc, phrase) => acc + (statByQuery.get(phrase)?.impressions ?? 0),
          0
        )
        proposalDrafts.push({
          type: 'minus_words',
          topicKey: 'minus_words',
          payload: { phrases: disputed, verdicts: disputedVerdicts },
          argument: `Запросы с объёмом показов и нулём заявок за период: ${argumentParts.join('; ')}. Минусовка уберёт нецелевой расход — больше заявок на рубль.`,
          question: 'Занести в минусы?',
          triggerMetric: 'impressions_no_conversions',
          triggerValue,
        })
      }
    }
  } catch (err) {
    pushBlockError('минусовка', err)
  }

  // 6b. ПОВЕДЕНЧЕСКИЕ минус-кандидаты (М2, пофразное зрение Метрики) — ТОЛЬКО
  // ПРЕДЛОЖЕНИЕМ владельцу, НЕ авто-минус. Фраза с рекламным трафиком (≥ порога
  // визитов), плохим поведением на сайте (высокий отказ / мгновенный уход) и нулём
  // заявок — вероятный нецелевой трафик, видимый по поведению задолго до порога
  // показов. Конвертер-защита (реестр + 30д по тексту) и гео (вне-зону не дублируем
  // со структурной минусовкой) — как для обычных минусов. Метрика пуста → молчим.
  try {
    const phraseRows = (await latestSnapshotPayload<PhraseBehaviorRow[]>('metrika_phrase')) ?? []
    if (phraseRows.length > 0) {
      const behavioral = pickBehavioralMinusCandidates(phraseRows).filter((c) => {
        // Конвертер-защита: ≥1 заявка за 30д по тексту ИЛИ подтверждённый реестром — не трогаем.
        const conv30d = Math.max(
          conv30dByQueryText.get(normQueryKey(c.phrase)) ?? 0,
          isRegisteredConverter(c.phrase) ? 1 : 0
        )
        if (conv30d > 0) return false
        // Вне-зонные города уже ловит структурная минусовка — не дублируем предложением.
        return classifyQueryGeo(c.phrase) !== 'out_of_zone'
      })
      if (behavioral.length > 0) {
        const parts = behavioral.map((c) => {
          const beh =
            c.reason === 'high_bounce'
              ? `отказ ${Math.round(c.bounceRate)}%`
              : c.reason === 'short_duration'
                ? `${Math.round(c.avgDurationSec)} сек на сайте`
                : `отказ ${Math.round(c.bounceRate)}%, ${Math.round(c.avgDurationSec)} сек`
          return `«${c.phrase}» — ${c.visits} визитов, 0 заявок, ${beh}`
        })
        proposalDrafts.push({
          type: 'behavioral_minus',
          topicKey: 'behavioral_minus',
          payload: { phrases: behavioral.map((c) => c.phrase), behavior: behavioral },
          argument: `Фразы с рекламным трафиком, плохим поведением на сайте и нулём заявок за период: ${parts.join('; ')}. Похоже на нецелевой трафик — минусовка уберёт слив, больше заявок на рубль.`,
          question: 'Занести эти фразы в минусы по поведению?',
          triggerMetric: 'behavioral_visits_no_conv',
          triggerValue: behavioral.reduce((a, c) => a + c.visits, 0),
        })
        // ЭМИССИЯ диагноза не делаем: поведенческие сигналы в полигон-решения не
        // идут (sim не отдаёт пофразное поведение) — только предложение владельцу.
      }
    }
  } catch (err) {
    pushBlockError('поведенческие кандидаты', err)
  }

  // 7. СТАВКИ: ПОФРАЗНЫЙ экономбиддинг (Цикл 2.0). Ставка каждой фразы — по её
  // СОБСТВЕННОЙ головной экономике (запрос фразы = текст её ключа), а не по
  // групповой корзине. Ключ: CPL(tv) ∝ cpc(tv) (клики/CR сокращаются) — дешевле
  // уровень при сохранении заявок = дешевле заявка. Поэтому:
  //   • конвертер (заявки за окно > 0) → вход в нижний блок (дешевле TV75);
  //   • «горелка» (клики ≥ порога, заявок 0 за зрелое окно) → минимальный уровень;
  //   • тонкая (мало кликов) → вход/наблюдение.
  // Групповое усреднение (тянувшее беззаявочные фразы конвертящей группы в TV75)
  // убрано — оно и топило экономику (M1). Голова фразы наблюдаема без движка:
  // keyword.Keyword == query отчёта. Окно PHRASE_ECON_WINDOW_DAYS дозревает
  // заявки сквозь лаг. Потолок 400 ₽, премиум-вето, шум-гейт, карантин,
  // circuit breaker — в силе.
  try {
    const bidsSnap = (await latestSnapshotPayload<KeywordBidRecord[]>('keywordbids')) ?? []
    const keywordsForBids = (await latestSnapshotPayload<KeywordRecord[]>('keywords')) ?? []
    if (bidsSnap.length > 0) {
      // Мост keywordId → нормализованный текст ключа — ТОЛЬКО для реестра
      // подтверждённых конвертеров (страховка поверх, isRegisteredConverter).
      const keyTextById = new Map<number, string>(
        keywordsForBids.map((k) => [k.Id, normQueryKey(k.Keyword)])
      )
      // MAJOR-2: головная экономика фразы ПО КЛЮЧУ (CriterionId), НЕ по тексту
      // запроса. Ключи — broad match (запрос ≠ текст ключа): клики/заявки
      // приписываются КЛЮЧУ, на который Директ сматчил запрос. Окно = история из
      // ID-снапшотов 'query_criterion_daily' (дни СТРОГО до сегодня) + сегодняшний
      // отчёт rows по CriterionId. liveKeyIds отсекает автотаргет/орфан-ID (в
      // пофразный биддинг не идут). Ключ без данных окна → тонкая → hold.
      const liveKeyIds = new Set(keywordsForBids.map((k) => k.Id))
      const headStat = new Map<number, { clicks: number; leads: number }>()
      const addHead = (criterionId: number | null | undefined, clicks: number, leads: number) => {
        if (criterionId == null || !liveKeyIds.has(criterionId)) return
        const acc = headStat.get(criterionId) ?? { clicks: 0, leads: 0 }
        acc.clicks += clicks
        acc.leads += leads
        headStat.set(criterionId, acc)
      }
      // Защита конвертера для СТАВОК — по CriterionId (заявка защищает КЛЮЧ, на
      // который сматчился запрос). Для МИНУСА защита остаётся по тексту (выше).
      const conv30dByCriterion = new Map<number, number>()
      const addConv = (criterionId: number | null | undefined, conv: number) => {
        if (criterionId == null || !liveKeyIds.has(criterionId)) return
        conv30dByCriterion.set(criterionId, (conv30dByCriterion.get(criterionId) ?? 0) + conv)
      }
      const histEnd = new Date(dayStart.getTime() - DAY_MS)
      try {
        // М3: окна в РАБОЧИХ днях (история строго до сегодня + сегодняшние rows ниже).
        const headHist = await loadCriterionWindow(histEnd, PHRASE_ECON_WINDOW_WORKDAYS - 1)
        for (const [cid, s] of headHist) addHead(cid, s.clicks, s.conversions)
        const convHist = await loadCriterionWindow(histEnd, CONVERTER_PROTECT_WINDOW_WORKDAYS - 1)
        for (const [cid, s] of convHist) addConv(cid, s.conversions)
      } catch (err) {
        console.error('[boris-direct/brain] окно пофразной экономики по ключу недоступно', err)
      }
      for (const row of rows) {
        addHead(row.criterionId, row.clicks, row.conversions)
        addConv(row.criterionId, row.conversions)
      }

      // М3: CR кампании за окно (матожидание prior Байеса) — по агрегату headStat.
      let totalHeadClicks = 0
      let totalHeadLeads = 0
      for (const [, s] of headStat) {
        totalHeadClicks += s.clicks
        totalHeadLeads += s.leads
      }
      const campaignCr = totalHeadClicks > 0 ? totalHeadLeads / totalHeadClicks : PRIOR_CR_FALLBACK

      // М3.5: LEVEL-LOCK — читаем зафиксированные уровни фраз (kind 'phrase_tv_lock').
      // FAIL-SAFE: если ЧТЕНИЕ сломалось (throw) — уровни неизвестны → ставки в этот
      // тик НЕ трогаем и ничего не сбрасываем. Пустой снапшот (bootstrap: findFirst
      // вернул null) — НЕ поломка: карта пустая, уровни устанавливаются от вердикта.
      let levels: PhraseLevelMap = new Map()
      let levelsAvailable = true
      try {
        levels = deserializeLevels(await latestSnapshotPayload<PhraseLevelSnapshot>('phrase_tv_lock'))
      } catch (err) {
        console.error(
          '[boris-direct/brain] уровни phrase_tv_lock не прочитались — ставки в этот тик не трогаю',
          err
        )
        levelsAvailable = false
      }

      if (levelsAvailable) {
        const leadValueRub = getLeadValueRub()
        // hold-фразы сохраняют прежний lock (копируем поверх, обновляем только тронутые).
        // Прунинг: заносим только ЖИВЫЕ ключи (liveKeyIds) — локи снятых/удалённых фраз
        // не тащим вечно (иначе снапшот phrase_tv_lock растёт орфанами без нужды).
        const nextLevels: PhraseLevelMap = new Map(
          [...levels].filter(([id]) => liveKeyIds.has(id))
        )
        const enriched: EnrichedChange[] = []
        // Коды пачки правок — для префикса reason в write-gate (дубль в лог).
        const bidCodes = new Set<ReasonCode>()
        const keyTextOf = (id: number): string => keyTextById.get(id) ?? `#${id}`

        for (const bid of bidsSnap) {
          const auctionBids = bid.Search?.AuctionBids ?? []
          if (auctionBids.length === 0) continue
          const currentBidMicro = bid.Search?.Bid ?? 0
          // Головная экономика ЭТОГО ключа — по CriterionId (== bid.KeywordId).
          const head = headStat.get(bid.KeywordId) ?? { clicks: 0, leads: 0 }
          const conv30d = conv30dByCriterion.get(bid.KeywordId) ?? 0
          // Защита конвертера ПОВЕРХ Байеса (страховка, не ослаблена): реестровый
          // (converters.ts) ИЛИ ≥1 заявка за окно защиты — НЕ демоутится независимо
          // от posterior (заявка ценнее экономии на клике).
          const protectedConv =
            isProtectedConverter(conv30d) || isRegisteredConverter(keyTextById.get(bid.KeywordId))

          // ЭМПИРИЧЕСКИЙ БАЙЕС (М3): promote → нижний блок; demote → минимум; hold → не трогаем.
          const bv = phraseBidVerdict({ leads: head.leads, clicks: head.clicks, campaignCr })
          let verdict = bv.verdict
          if (verdict === 'demote' && protectedConv) verdict = 'promote' // защищённый — не роняем

          if (verdict === 'hold') {
            // Level-lock: hold — уровень фразы НЕ трогаем (прежний lock держится в nextLevels).
            decisions.push({
              type: 'hold',
              targetType: 'keyword',
              targetId: String(bid.KeywordId),
              summary: `держим уровень — вердикт неопределён (клики ${head.clicks}, заявки ${head.leads}, P<порога ${bv.pBelow.toFixed(2)})`,
              reasonCode: 'CORE_LOWER_BLOCK',
              factors: {
                fromMicro: currentBidMicro,
                headLeads: head.leads,
                headClicks: head.clicks,
                pBelow: Math.round(bv.pBelow * 100) / 100,
              },
            })
            continue
          }

          const baseTv = verdict === 'promote' ? TV_LOWER_BLOCK_ENTRY : TV_TAIL
          const phraseCode: ReasonCode = verdict === 'promote' ? 'PROVEN_CONVERTER_VOLUME' : 'TAIL_MIN_TV'

          // ШАГ4: МАРЖИНАЛЬНЫЙ ПОДЪЁМ ПОВЕРХ level-lock (вторая попытка). Кандидатный
          // upliftTv считаем ТОЛЬКО при открытом гейте недорасхода; level-lock применит
          // его лишь в момент (пере)установки уровня и далее ЗАМОРОЗИТ — надбавка НЕ
          // прыгает от posterior-шума (причина №1 провала М3). Закрытие гейта уровни НЕ
          // откатывает (они зафиксированы) — петля «газ↔расход» разорвана (причина №2).
          let upliftTv: number | null = null
          if (MARGINAL_UPLIFT_ENABLED && verdict === 'promote' && underspendGate.open) {
            const upl = recommendMarginalBid({
              auctionBids,
              posteriorCr: bv.posteriorMean,
              leadValueRub,
              cplCapPct: MARGINAL_CPL_CAP_PCT,
              currentBidMicro,
            })
            if (upl.changed && upl.targetTv != null) upliftTv = upl.targetTv
          }

          const lvl = resolveLevel({ prev: levels.get(bid.KeywordId), verdict, baseTv, upliftTv })
          nextLevels.set(bid.KeywordId, lvl.lock)
          const desiredTv = lvl.tv
          const uplifted = desiredTv > baseTv

          const rec: RecommendBidResult = recommendBid({ auctionBids, desiredTv, currentBidMicro })
          if (rec.changed) {
            // Уверенность вердикта для приоритета ramp-in: promote → P(CR≥порога),
            // demote → P(CR<порога). Exploration — promote тонкой беззаявочной фразы.
            const confidence = verdict === 'promote' ? 1 - bv.pBelow : bv.pBelow
            const isExploration = verdict === 'promote' && !protectedConv && head.leads === 0
            enriched.push({
              keywordId: bid.KeywordId,
              fromMicro: currentBidMicro,
              toMicro: rec.targetBidMicro,
              verdict,
              confidence,
              protectedConv,
              isExploration,
            })
            bidCodes.add(phraseCode)
            decisions.push({
              type: 'bid',
              targetType: 'keyword',
              targetId: String(bid.KeywordId),
              summary: `ставка к TV${rec.targetTv ?? '?'}${uplifted ? ' (маржинальный подъём при недорасходе)' : ''} по Байесу (заявки ${head.leads}, клики ${head.clicks})`,
              reasonCode: phraseCode,
              factors: {
                fromMicro: currentBidMicro,
                toMicro: rec.targetBidMicro,
                targetTv: rec.targetTv ?? 0,
                headLeads: head.leads,
                headClicks: head.clicks,
              },
            })
          } else {
            // Держимся. Природа фразы — тот же phraseCode; КРОМЕ случая, когда
            // держит именно потолок/отсутствие аукциона (это и есть причина).
            const holdCode: ReasonCode =
              rec.holdReason === 'ceiling'
                ? 'AUCTION_ABOVE_CEILING'
                : rec.holdReason === 'no_auction'
                  ? 'LOW_COVERAGE'
                  : phraseCode
            const holdSummary =
              rec.holdReason === 'ceiling'
                ? 'вход дороже потолка — держимся'
                : rec.holdReason === 'no_auction'
                  ? 'нет подходящей позиции аукциона — ждём'
                  : `уже на целевом уровне (заявки ${head.leads}, клики ${head.clicks})`
            decisions.push({
              type: 'hold',
              targetType: 'keyword',
              targetId: String(bid.KeywordId),
              summary: holdSummary,
              reasonCode: holdCode,
              factors: { fromMicro: currentBidMicro, headLeads: head.leads, headClicks: head.clicks },
            })
          }
        }

        // Персист уровней на следующий тик (guarded — незапись не роняет тик).
        try {
          await saveSnapshot(dayStart, 'phrase_tv_lock', serializeLevels(nextLevels))
        } catch (err) {
          console.error('[boris-direct/brain] снапшот phrase_tv_lock не записался', err)
        }

        // М3.5: RAMP-IN — план не влезает в CB целиком (после деплоя мозг хочет
        // перестроить полпортфеля), применяем ПОДМНОЖЕСТВО строго в рамках CB
        // (приоритет конвертеры), остаток НЕ храним очередью — пересчёт на след. тике.
        if (enriched.length > 0) {
          const ramp = selectRampInSubset(enriched)
          // Строка отчёта — только пока догоняем (есть остаток).
          if (ramp.deferred.length > 0) {
            reportData.portfolioRampIn = {
              applied: ramp.apply.length,
              planned: enriched.length,
              deferred: ramp.deferred.length,
            }
          }
          if (ramp.apply.length > 0) {
            // Префикс машинных кодов пачки в reason — дубль в payload лога.
            const bidsCodePrefix = (['PROVEN_CONVERTER_VOLUME', 'CORE_LOWER_BLOCK', 'TAIL_MIN_TV'] as const)
              .filter((code) => bidCodes.has(code))
              .join(',')
            const rampNote =
              ramp.deferred.length > 0 ? ` (ввод порциями: ${ramp.apply.length} из ${enriched.length})` : ''
            const gate = await applyBidChanges(
              ramp.apply,
              `[${bidsCodePrefix}] пофразный экономбиддинг (конвертер→нижний блок, горелка→минимум, тонкая→вход): ${ramp.apply.length} фраз${rampNote}`
            )
            if (gate.breakerTripped) {
              // Штатный ramp-in под CB до срабатывания доводить НЕ должен (подмножество
              // ≤ лимита по построению). Сработало → реальная аномалия. Немой стоп-алерт
              // ЗАПРЕЩЁН как класс — шлём владельцу СОДЕРЖАНИЕ остановленного плана.
              const stopped: CbStoppedChange[] = ramp.applyEnriched.map((c) => ({
                keyText: keyTextOf(c.keywordId),
                fromMicro: c.fromMicro,
                toMicro: c.toMicro,
                verdict: c.verdict,
              }))
              anomalies.push({
                severity: 'critical',
                kind: 'circuit_breaker',
                text: formatCbStoppedPlan({ changes: stopped }),
              })
              decisions.push({
                type: 'alert',
                targetType: 'campaign',
                targetId: String(DIRECT_CAMPAIGN_ID),
                summary: `circuit breaker: пачка правок ставок (${ramp.apply.length} шт.) вне паттерна`,
                reasonCode: 'CIRCUIT_BREAKER',
                factors: { changes: ramp.apply.length },
              })
            } else if (gate.writeErrors?.length) {
              // A: keywordbids.set вернул поэлементные Errors. Частичный успех
              // (applied=true) — часть ставок реально применилась; полный провал
              // (applied=false) — ничего. В обоих случаях аномалия.
              const summary = `ставки: ${ramp.apply.length} фраз к целевым позициям шкалы`
              anomalies.push({
                severity: 'critical',
                kind: gate.partial ? 'bids_partial_fail' : 'bids_write_fail',
                text: gate.partial
                  ? `Ставки применены ЧАСТИЧНО, часть фраз с ошибкой: ${gate.writeErrors.join('; ')}. Проверь ставки в кабинете.`
                  : `Ставки НЕ применились в Директе (ошибки API): ${gate.writeErrors.join('; ')}.`,
              })
              if (gate.applied) appliedSummaries.push(`${summary} (частично)`)
            } else {
              const summary = `ставки: ${ramp.apply.length} фраз к целевым позициям шкалы${rampNote}`
              if (gate.applied) appliedSummaries.push(summary)
              else wouldDoSummaries.push(summary)
            }
          }
        }
      }
    }
  } catch (err) {
    pushBlockError('ставки', err)
  }

  // 7.5 ГЛУБОКАЯ ДИАГНОСТИКА (сессия «Прозрение»): расписание / устройства /
  // демография / групповые минуса. ТОЛЬКО эмиссия диагноза (DecisionRecord) +
  // ПРЕДЛОЖЕНИЕ владельцу с цифрами. Действий Бориса НЕ меняет, write-набор НЕ
  // расширяет — применение новых типов правок только после пробы на тестовой
  // кампании и «да» владельца (Борис так и пишет в предложении). Все диагнозы
  // объёмно-гейтованы (config): на молодой/тонкой кампании молчат.
  try {
    const DIAG_WINDOW = 30
    const windowStart = new Date(dayStart.getTime() - (DIAG_WINDOW - 1) * DAY_MS)
    // Оконное сырьё по запросам (расход/конверсии/группы) — для расписания и
    // групповых минусов. Пусто (молодая кампания) → диагнозы просто молчат.
    const windowStats = await prisma.borisDirectQueryDailyStat.findMany({
      where: { date: { gte: windowStart, lte: dayStart } },
    })
    const settings = await latestSnapshotPayload<CampaignSettings>('campaign_settings')
    const bidmods = (await latestSnapshotPayload<BidModifierRecord[]>('bidmodifiers')) ?? []

    // (а) SCHEDULE_WASTE — будни/выходные по расходу и заявкам.
    const weekendDays = new Set<string>()
    let weekendSpend = 0
    let weekendConv = 0
    let weekdayConv = 0
    for (const s of windowStats) {
      const day = mskDay(s.date)
      const costRub = Number(s.costRub) // costRub — Prisma Decimal
      if (isWeekend(day)) {
        weekendSpend += costRub
        weekendConv += s.conversions
        if (costRub > 0) weekendDays.add(day)
      } else {
        weekdayConv += s.conversions
      }
    }
    const schedule = diagnoseScheduleWaste({
      weekendSpendRub: weekendSpend,
      weekendConversions: weekendConv,
      weekendDays: weekendDays.size,
      weekdayConversions: weekdayConv,
      hasSchedule: !!settings?.TimeTargeting,
    })
    if (schedule) {
      decisions.push(schedule.decision)
      proposalDrafts.push(schedule.proposal)
    }

    // (б) DEVICE_SKEW — М2: приоритет ТОЧНОМУ ₽-расходу из device-отчёта Директа
    // (Device × Clicks/Cost/Conversions за окно). Фолбэк — оценка по визитам Метрики
    // (costEstimated), если device-отчёт не готов/пуст. Fetch здесь (не в collect):
    // не мешает поллингу SQ/CP в тике «сбор». В полигоне CUSTOM-фейк без Device → []
    // → фолбэк на Метрику (в sim пусто) → DEVICE_SKEW молчит (байт-в-байт).
    const directDevice = (await fetchDeviceReport(mskDay(windowStart), yesterday)) ?? []
    let deviceRows: DeviceRow[] = []
    if (directDevice.length > 0) {
      deviceRows = directDevice.map((d) => ({
        device: normalizeDevice(d.device),
        clicks: d.clicks,
        conversions: d.conversions,
        costRub: d.costRub, // точный ₽ из отчёта Директа
        costEstimated: false,
      }))
    } else {
      const deviceStats =
        (await latestSnapshotPayload<
          Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>
        >('metrika_device')) ?? []
      if (deviceStats.length > 0) {
        const windowSpend = (await loadDailyTotals(dayStart, DIAG_WINDOW)).reduce(
          (a, t) => a + t.spendRub,
          0
        )
        const totalVisits = deviceStats.reduce((a, d) => a + d.visits, 0)
        deviceRows = deviceStats.map((d) => ({
          device: normalizeDevice(d.device),
          clicks: d.visits,
          conversions: d.goalReaches,
          costRub: totalVisits > 0 ? windowSpend * (d.visits / totalVisits) : 0,
          costEstimated: true,
        }))
      }
    }
    if (deviceRows.length > 0) {
      const skew = diagnoseDeviceSkew(deviceRows, adjustedDeviceTypes(bidmods))
      if (skew) {
        decisions.push(skew.decision)
        proposalDrafts.push(skew.proposal)
      }
    }

    // (в) AUDIENCE_WASTE — срез Метрики по демографии (порог высокий: B2B).
    const demoStats =
      (await latestSnapshotPayload<
        Array<{ gender: string; age: string; visits: number; goalReaches: number }>
      >('metrika_demo')) ?? []
    if (demoStats.length > 0) {
      const overallConv = demoStats.reduce((a, d) => a + d.goalReaches, 0)
      // Реальное множество уже настроенных демо-корректировок (М2): не предлагаем
      // владельцу то, что уже стоит (раньше сюда шёл пустой Set).
      const audience = diagnoseAudienceWaste(
        buildDemoSegments(demoStats),
        overallConv,
        adjustedDemoSegments(bidmods)
      )
      if (audience) {
        decisions.push(audience.decision)
        proposalDrafts.push(audience.proposal)
      }
    }

    // (г) GROUP_MINUS_GAP — минуса кампании vs конвертящие запросы групп.
    const campaignNegatives = settings?.NegativeKeywords?.Items ?? []
    if (campaignNegatives.length > 0 && windowStats.length > 0) {
      const byQuery = new Map<
        string,
        { query: string; adGroupId: string; adGroupName?: string; clicks: number; conversions: number }
      >()
      for (const s of windowStats) {
        const key = `${s.adGroupId}\0${s.query}`
        const acc = byQuery.get(key) ?? {
          query: s.query,
          adGroupId: s.adGroupId,
          adGroupName: s.adGroupName ?? undefined,
          clicks: 0,
          conversions: 0,
        }
        acc.clicks += s.clicks
        acc.conversions += s.conversions
        byQuery.set(key, acc)
      }
      const converting = [...byQuery.values()].filter((q) => q.conversions > 0)
      for (const gap of diagnoseGroupMinusGap(campaignNegatives, converting)) {
        decisions.push(gap.decision)
        proposalDrafts.push(gap.proposal)
      }
    }
  } catch (err) {
    pushBlockError('глубокая диагностика', err)
  }

  // 8. Финал: отчёты помечаем обработанными.
  try {
    await markProcessed()
  } catch (err) {
    pushBlockError('финализация отчётов', err)
  }

  // 9. Память-опыт: замер исходов; по понедельникам МСК — уроки.
  const memory = await runMemoryHooks(now)

  emitAnomalyAlerts()
  return {
    status: 'done',
    appliedSummaries,
    wouldDoSummaries,
    proposalDrafts,
    verdicts,
    reportData,
    anomalies,
    decisions,
    attribution,
    memory,
  }
}
