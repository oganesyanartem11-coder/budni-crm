/**
 * М5 ШАГ 3: «эффект первой порции» — живой арбитр отложенного решения о подъёмах.
 *
 * Когорта A — фразы, поднятые применённой порцией ramp-in 10.07 (из ActionLog);
 * когорта B — остальной активный портфель. Метрики до/после дня подъёма по каждой
 * когорте (клики/показы/расход/конверсии/CPC/CPL). Пока кликов в A мало
 * (COHORT_MIN_CLICKS) — блок пишет «данных мало, вывод рано» БЕЗ вердикта. Никаких
 * автоматических решений — только текст владельцу.
 *
 * ЧИСТЫЕ функции (выделение когорты, разбивка) + тонкий prisma/reports-I/O. Живёт
 * вне мозг-тика (зовётся из weekly-роута) → полигон не исполняет (sim-нейтрально).
 */

import { prisma } from '@/lib/db/prisma'
import { mskDayStartUtc } from './brain'
import { parseCriterionId, readReportConversions } from './attribution'
import { pollReport, parseReportTsv, buildSearchQueryReportBody } from './reports'

// ---------- Типы ----------

/** Сырые метрики ключа за окно (из SQ-отчёта, агрегат по CriterionId). */
export interface CriterionStat {
  impressions: number
  clicks: number
  costRub: number
  conversions: number
}

/** Метрики когорты за окно + число ключей и дней окна (для «/день»). */
export interface CohortMetrics {
  keywords: number
  days: number
  impressions: number
  clicks: number
  spendRub: number
  conversions: number
}

/** Метрики когорты до и после дня подъёма. */
export interface CohortWindowStats {
  before: CohortMetrics
  after: CohortMetrics
}

/** Полный эффект: обе когорты + флаг достаточности данных. */
export interface CohortEffect {
  raiseDay: string
  cohortA: CohortWindowStats
  cohortB: CohortWindowStats
  enoughData: boolean
}

// ---------- Чистая логика ----------

interface BidEntry {
  keywordId: number
  bidMicro: number
}

/** Массив {keywordId, bidMicro} из JSON лога, или []. */
function asBidEntries(v: unknown): BidEntry[] {
  if (!Array.isArray(v)) return []
  const out: BidEntry[] = []
  for (const e of v) {
    if (e && typeof e === 'object' && typeof (e as BidEntry).keywordId === 'number' && typeof (e as BidEntry).bidMicro === 'number') {
      out.push({ keywordId: (e as BidEntry).keywordId, bidMicro: (e as BidEntry).bidMicro })
    }
  }
  return out
}

/**
 * Из ПРИМЕНЁННЫХ логов keywordbids.set выделяет ключи, чья ставка ВЫРОСЛА
 * (after.bid > before.bid) — это и есть поднятые порцией. applied=false и
 * понижения/без-изменений отбрасываются.
 */
export function raisedKeywordIdsFromLogs(
  logs: Array<{ before: unknown; after: unknown; applied: boolean }>
): Set<number> {
  const raised = new Set<number>()
  for (const log of logs) {
    if (!log.applied) continue
    const before = new Map(asBidEntries(log.before).map((e) => [e.keywordId, e.bidMicro]))
    for (const a of asBidEntries(log.after)) {
      const b = before.get(a.keywordId)
      if (b != null && a.bidMicro > b) raised.add(a.keywordId)
    }
  }
  return raised
}

const EMPTY: CriterionStat = { impressions: 0, clicks: 0, costRub: 0, conversions: 0 }

/** Суммирует метрики множества ключей из карты по CriterionId. */
function sumFor(ids: Set<number>, byCrit: Map<number, CriterionStat>, days: number): CohortMetrics {
  const acc: CohortMetrics = { keywords: ids.size, days, impressions: 0, clicks: 0, spendRub: 0, conversions: 0 }
  for (const id of ids) {
    const s = byCrit.get(id)
    if (!s) continue
    acc.impressions += s.impressions
    acc.clicks += s.clicks
    acc.spendRub += s.costRub
    acc.conversions += s.conversions
  }
  return acc
}

/**
 * Разбивает метрики до/после на когорту A (поднятые) и B (все прочие ключи,
 * встреченные в любом из окон). beforeDays/afterDays — длины окон (для «/день»).
 */
export function buildCohortStats(
  cohortAIds: Set<number>,
  beforeByCrit: Map<number, CriterionStat>,
  afterByCrit: Map<number, CriterionStat>,
  beforeDays: number,
  afterDays: number
): { cohortA: CohortWindowStats; cohortB: CohortWindowStats } {
  const allIds = new Set<number>([...beforeByCrit.keys(), ...afterByCrit.keys()])
  const bIds = new Set<number>()
  for (const id of allIds) if (!cohortAIds.has(id)) bIds.add(id)

  return {
    cohortA: {
      before: sumFor(cohortAIds, beforeByCrit, beforeDays),
      after: sumFor(cohortAIds, afterByCrit, afterDays),
    },
    cohortB: {
      before: sumFor(bIds, beforeByCrit, beforeDays),
      after: sumFor(bIds, afterByCrit, afterDays),
    },
  }
}

/** Достаточно ли данных для вывода: клики когорты A ПОСЛЕ подъёма ≥ порога. */
export function cohortHasEnoughData(a: CohortWindowStats, minClicks: number): boolean {
  return a.after.clicks >= minClicks
}

// ---------- prisma / reports I/O (тонкий слой) ----------

const DAY_MS = 24 * 60 * 60 * 1000

/** МСК-день (UTC+3), 'YYYY-MM-DD'. */
function mskDayStr(d: Date): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10)
}

/** Поднятые в день raiseDay ключи из ActionLog (applied keywordbids.set, рост ставки). */
export async function getRaisedKeywordIds(raiseDay: string): Promise<Set<number>> {
  const start = mskDayStartUtc(raiseDay)
  const end = new Date(start.getTime() + DAY_MS)
  const logs = await prisma.borisDirectActionLog.findMany({
    where: { action: 'keywordbids.set', applied: true, createdAt: { gte: start, lt: end } },
    select: { before: true, after: true, applied: true },
  })
  return raisedKeywordIdsFromLogs(logs)
}

/** Поллинг SQ-отчёта в рамках бюджета крона. */
async function fetchSq(body: unknown, maxAttempts = 9): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const poll = await pollReport(body)
    if (poll.status === 'ready') return poll.tsv
    if (poll.status === 'failed') return null
    await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 4) * 1000))
  }
  return null
}

/** SQ-отчёт за [from..to] → агрегат по CriterionId (клики/показы/расход/конверсии). */
async function sqByCriterion(from: string, to: string, tag: string): Promise<Map<number, CriterionStat>> {
  const stamp = Math.floor(Date.now() / 1000)
  const tsv = await fetchSq(buildSearchQueryReportBody(from, to, `bd_cohort_${tag}_${stamp}`))
  const byCrit = new Map<number, CriterionStat>()
  if (!tsv) return byCrit
  for (const row of parseReportTsv(tsv)) {
    const cid = parseCriterionId(row.CriterionId)
    if (cid == null) continue
    const cur = byCrit.get(cid) ?? { ...EMPTY }
    cur.impressions += Number(row.Impressions) || 0
    cur.clicks += Number(row.Clicks) || 0
    cur.costRub += Number(String(row.Cost ?? '').replace(',', '.')) || 0
    cur.conversions += readReportConversions(row)
    byCrit.set(cid, cur)
  }
  return byCrit
}

/**
 * Собирает эффект первой порции: когорта поднятых (ActionLog@raiseDay) vs остальной
 * портфель, метрики до (окно beforeDays до raiseDay) и после (raiseDay..toDay).
 * Любая недоступность отчётов → null (weekly просто не печатает блок). Read-only.
 */
export async function getCohortEffect(
  raiseDay: string,
  toDay: string,
  beforeDays: number,
  minClicks: number
): Promise<CohortEffect | null> {
  const cohortAIds = await getRaisedKeywordIds(raiseDay)
  if (cohortAIds.size === 0) return null // нечего сравнивать (порция не найдена в логах)

  const raiseStart = mskDayStartUtc(raiseDay)
  const beforeFrom = mskDayStr(new Date(raiseStart.getTime() - beforeDays * DAY_MS))
  const beforeTo = mskDayStr(new Date(raiseStart.getTime() - DAY_MS))
  const afterDays = Math.max(
    1,
    Math.round((mskDayStartUtc(toDay).getTime() - raiseStart.getTime()) / DAY_MS) + 1
  )

  const [beforeByCrit, afterByCrit] = await Promise.all([
    sqByCriterion(beforeFrom, beforeTo, 'bef'),
    sqByCriterion(raiseDay, toDay, 'aft'),
  ])
  if (afterByCrit.size === 0) return null // после отчёт не дозрел → блок не печатаем

  const { cohortA, cohortB } = buildCohortStats(cohortAIds, beforeByCrit, afterByCrit, beforeDays, afterDays)
  return { raiseDay, cohortA, cohortB, enoughData: cohortHasEnoughData(cohortA, minClicks) }
}
