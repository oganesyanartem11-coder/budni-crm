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
  pollReport,
  parseReportTsv,
} from './reports'
import {
  getGoalStatsByDay,
  getGoalStatsByDevice,
  getGoalStatsByDemographics,
  getGoalStatsByHour,
} from './metrika-client'
import {
  diagnoseDeviceSkew,
  diagnoseScheduleWaste,
  diagnoseAudienceWaste,
  diagnoseGroupMinusGap,
  normalizeDevice,
  adjustedDeviceTypes,
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
  type QueryStatRow,
} from './attribution'
import type { DecisionRecord, ReasonCode } from './reason-codes'
import {
  DIRECT_CAMPAIGN_ID,
  DATA_MISMATCH_RATIO,
  DATA_MISMATCH_MIN_COUNT,
  PHRASE_MIN_CLICKS,
  PHRASE_ECON_WINDOW_DAYS,
  TV_LOWER_BLOCK_ENTRY,
  TV_TAIL,
} from './config'
import { detectAnomalies, type Anomaly } from './anomalies'
import { classifyQueryGeo, isGeoMinusReason } from './geo'
import {
  isProtectedConverter,
  filterOutProtectedConverters,
  CONVERTER_PROTECT_WINDOW_DAYS,
} from './economics'
import {
  isInQuarantine,
  pickDataDrivenMinusCandidates,
  prepareMinusCandidates,
  recommendBid,
} from './rules'
import { applyBidChanges, applyNegativeKeywords, type BidChange } from './write-gate'
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
  try {
    await saveSnapshot(tickToday, 'campaign_settings', await getCampaignSettings())
  } catch (err) {
    pushError('campaigns.get(settings)', err)
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

    const leadsYesterday = await prisma.landingLead.count({
      where: { createdAt: { gte: tickYesterday, lt: tickToday } },
    })
    const leads7d = await prisma.landingLead.count({
      where: { createdAt: { gte: new Date(tickYesterday.getTime() - 7 * DAY_MS), lt: tickYesterday } },
    })

    anomalies = detectAnomalies({
      spentYesterdayRub: yesterdayTotals?.spendRub ?? null,
      avgSpend7dRub: avg(history.map((t) => t.spendRub)),
      impressionsYesterday: yesterdayTotals?.impressions ?? null,
      avgImpressions7d: avg(history.map((t) => t.impressions)),
      addMetricaTag: campaign ? getAddMetricaTagValue(campaign) : null,
      leadsYesterday,
      avgLeads7d: leads7d / 7,
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

/** Последний ПРИМЕНЁННЫЙ полный список минусов из лога действий (наш учёт:
 * живой список из campaigns.get не читаем — см. комментарий в minus-блоке). */
async function getLastAppliedNegativesList(): Promise<string[]> {
  const last = await prisma.borisDirectActionLog.findFirst({
    where: { action: 'campaigns.update.negatives', applied: true },
    orderBy: { createdAt: 'desc' },
  })
  const after = last?.after
  if (Array.isArray(after) && after.every((item) => typeof item === 'string')) {
    return after as string[]
  }
  return []
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
    const leads = await getLeadsForPeriod(dayStart, dayEnd)
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
    const metrikaGoal =
      (await latestSnapshotPayload<Array<{ goalReaches?: number }>>('metrika_goal'))?.reduce(
        (acc, g) => acc + (g.goalReaches ?? 0),
        0
      ) ?? 0
    const counts = [reportConv, metrikaGoal, leadsTotal].filter((c) => Number.isFinite(c))
    const maxC = Math.max(...counts)
    const minC = Math.min(...counts)
    if (maxC >= DATA_MISMATCH_MIN_COUNT && maxC >= minC * DATA_MISMATCH_RATIO) {
      decisions.push({
        type: 'diagnosis',
        targetType: 'campaign',
        targetId: String(DIRECT_CAMPAIGN_ID),
        summary: `источники заявок расходятся: отчёт ${reportConv}, Метрика ${metrikaGoal}, БД ${leadsTotal} — первопричина в данных, не в трафике`,
        reasonCode: 'DATA_MISMATCH',
        factors: { reportConv, metrikaGoal, leadsTotal },
      })
    }
  } catch (err) {
    pushBlockError('сверка источников', err)
  }

  // 5. Карантин: дней с данными = дни со снапшотом кампании; клики — сумма
  // по дневным итогам (включая только что записанный вчерашний день).
  let quarantine = false
  // Цифры, на которые опёрся карантин, — для машинной записи (эмиссия).
  let quarantineFactors: Record<string, number | string> = {}
  try {
    const campaignDays = await prisma.borisDirectSnapshot.findMany({
      where: { kind: 'campaign' },
      select: { tickDate: true },
      distinct: ['tickDate'],
    })
    const allTotals = await loadDailyTotals(dayStart, 30)
    const totalClicks = allTotals.reduce((acc, t) => acc + t.clicks, 0)
    quarantineFactors = { daysOfData: campaignDays.length, totalClicks }
    quarantine = isInQuarantine({ daysOfData: campaignDays.length, totalClicks })
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

  // ЭКОНОМИЧЕСКАЯ КОНСТИТУЦИЯ (ШАГ 6): защита конвертеров по окну 30 дней.
  // Фраза с ≥1 заявкой за 30д — НЕ кандидат на минус/понижение с мотивом
  // «дорого» (только наблюдаем/кормим). Считаем один раз, используем в §6
  // (минус) и §7 (ставки). Ключи: по (группа+запрос) и по тексту запроса.
  const conv30dByGroupQuery = new Map<string, number>()
  const conv30dByQueryText = new Map<string, number>()
  try {
    const convWindowStart = new Date(
      dayStart.getTime() - (CONVERTER_PROTECT_WINDOW_DAYS - 1) * DAY_MS
    )
    const stats30 = await prisma.borisDirectQueryDailyStat.findMany({
      where: { date: { gte: convWindowStart, lte: dayStart } },
    })
    for (const s of stats30) {
      const nq = normQueryKey(s.query)
      const gk = `${s.adGroupId}\0${nq}`
      conv30dByGroupQuery.set(gk, (conv30dByGroupQuery.get(gk) ?? 0) + s.conversions)
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
      const windowStartMinus = new Date(dayStart.getTime() - (PHRASE_ECON_WINDOW_DAYS - 1) * DAY_MS)
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
      (q) => conv30dByQueryText.get(normQueryKey(q)) ?? 0
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

      // existingMinus пустой сознательно: живой список NegativeKeywords из
      // campaigns.get не читаем (FieldNames транспорта не трогаем) — дедуп
      // против живого списка делает сам Яндекс (10140 «дубль» = warning,
      // не ошибка, операция применяется).
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
        // campaigns.update ЗАМЕЩАЕТ список — шлём объединённый набор.
        // Наш учёт «предыдущего полного списка» — after последнего применённого
        // campaigns.update.negatives (живой список не читаем, см. выше).
        const previousList = await getLastAppliedNegativesList()
        const merged = [...previousList]
        for (const phrase of autonomous) {
          if (!merged.includes(phrase)) merged.push(phrase)
        }
        // Префикс машинного кода в reason — дубль записи в payload лога
        // действий. Текст после скобок прежний.
        const negativesCodePrefix = (['STRUCTURAL_TRASH', 'DATA_NO_CONV'] as const)
          .filter((code) => autonomousCodes.has(code))
          .join(',')
        const gate = await applyNegativeKeywords(
          merged,
          previousList,
          `[${negativesCodePrefix}] минусовка: ${autonomous.length} структурных кандидатов (показы ≥ порога, конверсий 0): ${autonomous.join(', ')}`
        )
        const summary = `минус-фразы (${autonomous.length}): ${autonomous.join(', ')}`
        if (gate.applied) appliedSummaries.push(summary)
        else wouldDoSummaries.push(summary)
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
      // Мост keywordId → нормализованный текст ключа (голова фразы).
      const keyTextById = new Map<number, string>(
        keywordsForBids.map((k) => [k.Id, normQueryKey(k.Keyword)])
      )
      // Головная экономика фразы за окно созревания: (adGroupId, normQuery) →
      // {clicks, leads}. Источник — накопленный BorisDirectQueryDailyStat (в §3
      // уже дописан вчерашний день) + сегодняшний отчёт rows как подстраховка.
      const windowStartBids = new Date(dayStart.getTime() - (PHRASE_ECON_WINDOW_DAYS - 1) * DAY_MS)
      const headStat = new Map<string, { clicks: number; leads: number }>()
      const addHead = (adGroupId: string, query: string, clicks: number, leads: number) => {
        const key = `${adGroupId}\0${normQueryKey(query)}`
        const acc = headStat.get(key) ?? { clicks: 0, leads: 0 }
        acc.clicks += clicks
        acc.leads += leads
        headStat.set(key, acc)
      }
      try {
        const ws = await prisma.borisDirectQueryDailyStat.findMany({
          where: { date: { gte: windowStartBids, lte: dayStart } },
        })
        for (const s of ws) addHead(s.adGroupId, s.query, s.clicks, s.conversions)
      } catch (err) {
        console.error('[boris-direct/brain] окно пофразной экономики недоступно', err)
      }
      for (const row of rows) addHead(row.adGroupId, row.query, row.clicks, row.conversions)

      const changes: BidChange[] = []
      // Коды пачки правок — для префикса reason в write-gate (дубль в лог).
      const bidCodes = new Set<ReasonCode>()
      for (const bid of bidsSnap) {
        const auctionBids = bid.Search?.AuctionBids ?? []
        if (auctionBids.length === 0) continue
        const groupId = String(bid.AdGroupId)
        const currentBidMicro = bid.Search?.Bid ?? 0
        // Головная экономика ЭТОЙ фразы (её собственный запрос).
        const head = headStat.get(`${groupId}\0${keyTextById.get(bid.KeywordId) ?? ''}`) ?? {
          clicks: 0,
          leads: 0,
        }
        // Тонкая фраза (мало кликов, нет заявок) — НЕ трогаем ставку: судить не
        // на чем, а болтанка вредит дисциплине (демоутнутая горелка, у которой
        // клики выпали из окна, не должна прыгать назад в 65). Только наблюдаем.
        if (head.leads === 0 && head.clicks < PHRASE_MIN_CLICKS) {
          decisions.push({
            type: 'hold',
            targetType: 'keyword',
            targetId: String(bid.KeywordId),
            summary: `тонкая фраза — наблюдаем (клики ${head.clicks})`,
            reasonCode: 'CORE_LOWER_BLOCK',
            factors: { fromMicro: currentBidMicro, headLeads: head.leads, headClicks: head.clicks },
          })
          continue
        }
        // Пофразная классификация → целевой уровень + код природы фразы.
        // Конвертер → вход в нижний блок (дешевле TV75), горелка → минимум.
        // Cut 2 (спуск сильных конвертеров к минимуму) ОТКЛОНЁН витком 5: давал
        // +2 economics, но −9 discipline / −12 anomalies (болтанка вокруг порога
        // заявок = «пила»). Чистый спуск требует bounce-lock — в бэклог.
        // ЭКОНОМИЧЕСКАЯ КОНСТИТУЦИЯ (ШАГ 6a): конвертера за 30д НЕ понижаем в
        // минимум как «горелку» (заявка ценнее экономии на клике). Головная
        // экономика 14д ИЛИ ≥1 заявка за 30д → трактуем как конвертера (нижний
        // блок, «кормим»), а не хвост.
        const conv30d =
          conv30dByGroupQuery.get(`${groupId}\0${keyTextById.get(bid.KeywordId) ?? ''}`) ?? 0
        const converter = head.leads > 0 || isProtectedConverter(conv30d)
        const desiredTv = converter ? TV_LOWER_BLOCK_ENTRY : TV_TAIL
        const phraseCode: ReasonCode = converter ? 'PROVEN_CONVERTER_VOLUME' : 'TAIL_MIN_TV'
        const rec = recommendBid({ auctionBids, desiredTv, currentBidMicro })
        if (rec.changed) {
          changes.push({ keywordId: bid.KeywordId, fromMicro: currentBidMicro, toMicro: rec.targetBidMicro })
          bidCodes.add(phraseCode)
          decisions.push({
            type: 'bid',
            targetType: 'keyword',
            targetId: String(bid.KeywordId),
            summary: `ставка к TV${rec.targetTv ?? '?'} по пофразной экономике (заявки ${head.leads}, клики ${head.clicks})`,
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

      if (changes.length > 0) {
        // Префикс машинных кодов пачки в reason — дубль в payload лога.
        const bidsCodePrefix = (['PROVEN_CONVERTER_VOLUME', 'CORE_LOWER_BLOCK', 'TAIL_MIN_TV'] as const)
          .filter((code) => bidCodes.has(code))
          .join(',')
        const gate = await applyBidChanges(
          changes,
          `[${bidsCodePrefix}] пофразный экономбиддинг (конвертер→нижний блок, горелка→минимум, тонкая→вход): ${changes.length} фраз`
        )
        if (gate.breakerTripped) {
          anomalies.push({
            severity: 'critical',
            kind: 'circuit_breaker',
            text: `Circuit breaker остановил пачку правок ставок (${changes.length} шт.) — вне паттерна, нужен разбор владельцем.`,
          })
          // ЭМИССИЯ: сработавший предохранитель — машинный alert.
          decisions.push({
            type: 'alert',
            targetType: 'campaign',
            targetId: String(DIRECT_CAMPAIGN_ID),
            summary: `circuit breaker: пачка правок ставок (${changes.length} шт.) вне паттерна`,
            reasonCode: 'CIRCUIT_BREAKER',
            factors: { changes: changes.length },
          })
        } else {
          const summary = `ставки: ${changes.length} фраз к целевым позициям шкалы`
          if (gate.applied) appliedSummaries.push(summary)
          else wouldDoSummaries.push(summary)
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

    // (б) DEVICE_SKEW — срез Метрики по устройствам + текущие корректировки.
    // costRub — оценка (доля визитов × расход окна): Метрика даёт визиты, не ₽.
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
      const deviceRows: DeviceRow[] = deviceStats.map((d) => ({
        device: normalizeDevice(d.device),
        clicks: d.visits,
        conversions: d.goalReaches,
        costRub: totalVisits > 0 ? windowSpend * (d.visits / totalVisits) : 0,
        costEstimated: true,
      }))
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
      const audience = diagnoseAudienceWaste(buildDemoSegments(demoStats), overallConv, new Set())
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
