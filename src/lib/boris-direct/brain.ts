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
  type CampaignState,
  type KeywordRecord,
  type KeywordBidRecord,
} from './direct-client'
import {
  buildSearchQueryReportBody,
  buildCampaignPerformanceReportBody,
  pollReport,
  parseReportTsv,
} from './reports'
import { getGoalStatsByDay } from './metrika-client'
import {
  getLeadsForPeriod,
  splitLeadsByOrigin,
  toQueryStatRow,
  computeCostPerLead,
  type QueryStatRow,
} from './attribution'
import { detectAnomalies, type Anomaly } from './anomalies'
import {
  isInQuarantine,
  pickDataDrivenMinusCandidates,
  prepareMinusCandidates,
  recommendBid,
} from './rules'
import { applyBidChanges, applyNegativeKeywords, type BidChange } from './write-gate'
import { getDirectRoleState } from './state'
import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'

// ---------- Время: МСК = UTC+3 ----------

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MSK_OFFSET_MS = 3 * HOUR_MS

/** МСК-день даты в виде 'YYYY-MM-DD'. */
export function mskDay(date: Date): string {
  return new Date(date.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)
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

  // 2. Метрика за вчера (tickDate = МСК-день, за который данные).
  try {
    const goalStats = await getGoalStatsByDay(yesterday, yesterday)
    await saveSnapshot(tickYesterday, 'metrika_goal', goalStats)
  } catch (err) {
    pushError('metrika.goal_by_day', err)
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
      // Модерацию объявлений отдельно не читаем — считаем REJECTED по фразам.
      rejectedAdsCount: keywords.filter((k) => k.Status === 'REJECTED').length,
      apiErrors,
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

export interface ProcessResult {
  status: 'waiting_report' | 'done' | 'quarantine'
  appliedSummaries: string[]
  wouldDoSummaries: string[]
  proposalDrafts: ProposalDraft[]
  verdicts: MinusVerdictDraft[]
  reportData: DailyReportData | null
  anomalies: Anomaly[]
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

export async function runProcessTick(now: Date = new Date()): Promise<ProcessResult> {
  const anomalies: Anomaly[] = []
  const appliedSummaries: string[] = []
  const wouldDoSummaries: string[] = []
  const proposalDrafts: ProposalDraft[] = []
  const verdicts: MinusVerdictDraft[] = []

  const { dateFrom: yesterday } = yesterdayMsk(now)
  const dayStart = mskDayStartUtc(yesterday)
  const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1)

  const pushBlockError = (block: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[boris-direct/brain] process: блок «${block}» упал`, err)
    anomalies.push({ severity: 'warn', kind: 'process_block_error', text: `блок «${block}»: ${message}` })
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
  } catch (err) {
    pushBlockError('лиды', err)
  }

  // 5. Карантин: дней с данными = дни со снапшотом кампании; клики — сумма
  // по дневным итогам (включая только что записанный вчерашний день).
  let quarantine = false
  try {
    const campaignDays = await prisma.borisDirectSnapshot.findMany({
      where: { kind: 'campaign' },
      select: { tickDate: true },
      distinct: ['tickDate'],
    })
    const allTotals = await loadDailyTotals(dayStart, 30)
    const totalClicks = allTotals.reduce((acc, t) => acc + t.clicks, 0)
    quarantine = isInQuarantine({ daysOfData: campaignDays.length, totalClicks })
  } catch (err) {
    pushBlockError('карантин', err)
    quarantine = true // не смогли посчитать → безопаснее не оптимизировать
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
    await markProcessed()
    return {
      status: 'quarantine',
      appliedSummaries,
      wouldDoSummaries,
      proposalDrafts,
      verdicts,
      reportData,
      anomalies,
    }
  }

  const state = await getDirectRoleState()

  // 6. МИНУСА: data-driven кандидаты → механика/ядро/дедуп → LLM-классификатор
  // структурного мусора → автономно ИЛИ предложение владельцу.
  try {
    const candidates = pickDataDrivenMinusCandidates(rows)
    if (candidates.length > 0) {
      const keywordsSnap = (await latestSnapshotPayload<KeywordRecord[]>('keywords')) ?? []
      const coreKeywords = keywordsSnap.map((k) => k.Keyword)

      // existingMinus пустой сознательно: живой список NegativeKeywords из
      // campaigns.get не читаем (FieldNames транспорта не трогаем) — дедуп
      // против живого списка делает сам Яндекс (10140 «дубль» = warning,
      // не ошибка, операция применяется).
      const prepared = prepareMinusCandidates(candidates, { coreKeywords, existingMinus: [] })

      const statByQuery = new Map(rows.map((r) => [r.query, r]))

      // LLM (light) — ТОЛЬКО суждение «структурный мусор или нет», никаких чисел.
      let classified: ClassifiedCandidate[] = []
      if (prepared.accepted.length > 0) {
        try {
          const system =
            getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen }) +
            `\n\nЗАДАЧА КЛАССИФИКАТОРА: для каждого кандидата в минус-фразы реши, СТРУКТУРНЫЙ ли это мусор для нашего бизнеса (доставка обедов на коллективы, Москва и МО): чужое кафе/бренд/навигация к конкуренту, запросы вне Москвы и МО, запросы не про доставку обедов на коллектив (вакансии, рецепты, розница на одного). Верни СТРОГО JSON-массив без пояснений и без markdown: [{"candidate": string, "structural": boolean, "confident": boolean, "reason": string}]. confident=true только если сомнений нет.`
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
      for (const phrase of prepared.accepted) {
        const cls = verdictByCandidate.get(phrase)
        if (cls && cls.structural && cls.confident) {
          autonomous.push(phrase)
          verdicts.push({ candidate: phrase, verdict: 'minus', reason: cls.reason || 'структурный мусор' })
        } else if (state.autoNegativesEnabled) {
          // Гейт спорных минусов снят обучением — спорные тоже в автономию.
          autonomous.push(phrase)
          verdicts.push({
            candidate: phrase,
            verdict: 'minus',
            reason: cls?.reason || 'гейт снят обучением — спорный кандидат в автономию',
          })
        } else {
          disputed.push(phrase)
          verdicts.push({
            candidate: phrase,
            verdict: cls?.structural ? 'minus' : 'keep',
            reason: cls?.reason || 'классификатор не дал уверенного вердикта — решает владелец',
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
        const gate = await applyNegativeKeywords(
          merged,
          previousList,
          `минусовка: ${autonomous.length} структурных кандидатов (показы ≥ порога, конверсий 0): ${autonomous.join(', ')}`
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

  // 7. СТАВКИ: бинарная шкала по снапшоту keywordbids + конверсии из отчёта.
  //
  // УПРОЩЕНИЕ (задокументировано): матч фраза↔запрос неточен, поэтому
  // «доказанный конвертер» считаем на уровне ГРУППЫ — группа с conversions>0
  // в отчёте по запросам → все её фразы isProvenConverter=true.
  // ЭВРИСТИКА ядра: ядро = фразы в группах с конверсиями ИЛИ в группах с CTR
  // выше среднего по кампании (лучший сигнал целевого спроса без конверсий).
  try {
    const bidsSnap = (await latestSnapshotPayload<KeywordBidRecord[]>('keywordbids')) ?? []
    if (bidsSnap.length > 0) {
      const convByGroup = new Map<string, number>()
      const clicksByGroup = new Map<string, number>()
      const impressionsByGroup = new Map<string, number>()
      for (const row of rows) {
        convByGroup.set(row.adGroupId, (convByGroup.get(row.adGroupId) ?? 0) + row.conversions)
        clicksByGroup.set(row.adGroupId, (clicksByGroup.get(row.adGroupId) ?? 0) + row.clicks)
        impressionsByGroup.set(
          row.adGroupId,
          (impressionsByGroup.get(row.adGroupId) ?? 0) + row.impressions
        )
      }

      const groupCtr = new Map<string, number>()
      for (const [groupId, groupImpressions] of impressionsByGroup) {
        if (groupImpressions > 0) {
          groupCtr.set(groupId, (clicksByGroup.get(groupId) ?? 0) / groupImpressions)
        }
      }
      const ctrValues = [...groupCtr.values()]
      const avgGroupCtr =
        ctrValues.length > 0 ? ctrValues.reduce((a, b) => a + b, 0) / ctrValues.length : 0

      const convertingGroups = new Set(
        [...convByGroup.entries()].filter(([, conv]) => conv > 0).map(([groupId]) => groupId)
      )
      const coreGroups = new Set([
        ...convertingGroups,
        ...[...groupCtr.entries()].filter(([, c]) => c > avgGroupCtr).map(([groupId]) => groupId),
      ])

      const changes: BidChange[] = []
      for (const bid of bidsSnap) {
        const auctionBids = bid.Search?.AuctionBids ?? []
        if (auctionBids.length === 0) continue
        const groupId = String(bid.AdGroupId)
        const currentBidMicro = bid.Search?.Bid ?? 0
        const rec = recommendBid({
          auctionBids,
          isProvenConverter: convertingGroups.has(groupId),
          isCore: coreGroups.has(groupId),
          currentBidMicro,
        })
        if (rec.changed) {
          changes.push({ keywordId: bid.KeywordId, fromMicro: currentBidMicro, toMicro: rec.targetBidMicro })
        }
      }

      if (changes.length > 0) {
        const gate = await applyBidChanges(
          changes,
          `ставки к бинарной шкале (конвертеры → TV75, ядро → вход в нижний блок, хвост → TV15): ${changes.length} фраз`
        )
        if (gate.breakerTripped) {
          anomalies.push({
            severity: 'critical',
            kind: 'circuit_breaker',
            text: `Circuit breaker остановил пачку правок ставок (${changes.length} шт.) — вне паттерна, нужен разбор владельцем.`,
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

  // 8. Финал: отчёты помечаем обработанными.
  try {
    await markProcessed()
  } catch (err) {
    pushBlockError('финализация отчётов', err)
  }

  return {
    status: 'done',
    appliedSummaries,
    wouldDoSummaries,
    proposalDrafts,
    verdicts,
    reportData,
    anomalies,
  }
}
