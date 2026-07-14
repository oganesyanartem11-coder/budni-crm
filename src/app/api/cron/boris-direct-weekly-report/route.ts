/**
 * Cron: Борис-Директ, недельный отчёт владельцу (понедельник утром).
 *
 * ШАГ 4 (недельный разбор №1): отчёт строится по Директ Reports за ВЕСЬ период
 * (добираем недостающие дни запросом, а не только по своим снапшотам — снапшоты
 * молодой роли не покрывают дни до её деплоя). Период печатается явно. Заявки —
 * ТРИ счётчика: Директ-атрибуция / Метрика / Доставлено (+ оговорка о слепоте БД
 * до 04.07). Агрегирует код, LLM только пересказывает.
 *
 * Защита от кривого расписания как в boris-morning-briefing: не понедельник МСК
 * → skip. При недоступности отчётов — мягкий фолбэк на снапшоты (отчёт обязан уйти).
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { withCronHeartbeat } from '@/lib/cron/with-heartbeat'
import { alreadyRanToday, markRanToday } from '@/lib/bot/daily-summary'
import { mskDay, mskDayStartUtc, type DailyReportData } from '@/lib/boris-direct/brain'
import { getLlmSpendForPeriod } from '@/lib/boris-direct/llm'
import { sendToDirectChat } from '@/lib/boris-direct/telegram'
import { generateWeeklyReportText } from '@/lib/boris-direct/report-texts'
import { generateWeeklyConsilium } from '@/lib/boris-direct/consilium'
import { persistConsilium } from '@/lib/boris-direct/questions'
import { getActiveLessonsReport } from '@/lib/boris-direct/lessons'
import {
  pollReport,
  parseReportTsv,
  buildCampaignPerformanceReportBody,
  buildSearchQueryReportBody,
  buildMatchTypeShareReportBody,
} from '@/lib/boris-direct/reports'
import { toQueryStatRow, getLeadsForPeriod, splitLeadsByOrigin, dedupeLeadsByPhone } from '@/lib/boris-direct/attribution'
import { getWonDeals, aggregateRevenueByPhrase } from '@/lib/boris-direct/deals'
import { getCohortEffect } from '@/lib/boris-direct/cohorts'
import { filterOutTestLeads } from '@/lib/boris-direct/test-markers'
import { getGoalStatsByDay } from '@/lib/boris-direct/metrika-client'
import { isWorkday } from '@/lib/boris-direct/workdays'
import {
  MICRO,
  DAILY_BUDGET_MICRO,
  UPLIFT_COHORT_RAISE_DAY,
  COHORT_MIN_CLICKS,
  PHRASE_ECON_WINDOW_WORKDAYS,
} from '@/lib/boris-direct/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const JOB_LABEL = 'boris-direct-weekly-report'
const DAY_MS = 24 * 60 * 60 * 1000

/** Дата появления persist LandingLead — до неё БД слепа (ШАГ 4в). */
const DB_BLIND_BEFORE_MSK = '2026-07-04'

/** МСК weekday (1..7, Пн=1, Вс=7). UTC+3 без учёта сезона (Москва без DST). */
function mskWeekday(now: Date): number {
  const m = new Date(now.getTime() + 3 * 3600_000)
  const d = m.getUTCDay()
  return d === 0 ? 7 : d
}

const num = (s: string | undefined): number => {
  const v = s?.trim()
  if (!v || v === '--') return 0
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/** Поллинг отчёта в рамках бюджета крона (маленькая кампания зреет за 1-2 тика). */
async function fetchReportTsv(body: unknown, maxAttempts = 9): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const poll = await pollReport(body)
    if (poll.status === 'ready') return poll.tsv
    if (poll.status === 'failed') {
      console.error('[boris-direct/weekly] отчёт failed:', poll.error)
      return null
    }
    await new Promise((r) => setTimeout(r, Math.min(poll.retryInSec, 4) * 1000))
  }
  return null
}

/**
 * Строит days из отчётов Директа за период + заявок из БД (тест-фильтр).
 * Возвращает null, если отчёты недоступны (вызывающий уйдёт в фолбэк на снапшоты).
 */
async function buildDaysFromReports(
  fromDay: string,
  toDay: string,
  from: Date,
  to: Date
): Promise<{
  days: DailyReportData[]
  directAttrib: number
  matchTypeShare?: { synonymPct: number; synonymClicks: number; keywordClicks: number }
} | null> {
  const stamp = Math.floor(Date.now() / 1000)
  const [cpTsv, sqTsv, mtTsv] = await Promise.all([
    fetchReportTsv(buildCampaignPerformanceReportBody(fromDay, toDay, `bd_wk_cp_${stamp}`)),
    fetchReportTsv(buildSearchQueryReportBody(fromDay, toDay, `bd_wk_sq_${stamp}`)),
    fetchReportTsv(buildMatchTypeShareReportBody(fromDay, toDay, `bd_wk_mt_${stamp}`)),
  ])
  if (!cpTsv) return null

  // М2: доля SYNONYM-трафика (клики по типу соответствия). Отдельный отчёт (MatchType
  // дробит строки — в дневной SQ его не кладём). Недоступен → строку не печатаем.
  let matchTypeShare: { synonymPct: number; synonymClicks: number; keywordClicks: number } | undefined
  if (mtTsv) {
    let keywordClicks = 0
    let synonymClicks = 0
    for (const row of parseReportTsv(mtTsv)) {
      const clicks = num(row.Clicks)
      if (row.MatchType === 'SYNONYM') synonymClicks += clicks
      else if (row.MatchType === 'KEYWORD') keywordClicks += clicks
    }
    const total = keywordClicks + synonymClicks
    if (total > 0) matchTypeShare = { synonymPct: (synonymClicks / total) * 100, synonymClicks, keywordClicks }
  }

  // Per-day totals из CUSTOM_REPORT (Date × группа).
  const byDay = new Map<string, { spendRub: number; clicks: number; impressions: number }>()
  for (const row of parseReportTsv(cpTsv)) {
    const d = row.Date
    if (!d) continue
    const cur = byDay.get(d) ?? { spendRub: 0, clicks: 0, impressions: 0 }
    cur.spendRub += num(row.Cost)
    cur.clicks += num(row.Clicks)
    cur.impressions += num(row.Impressions)
    byDay.set(d, cur)
  }

  // Заявки из БД за период (тест-фильтр), разложенные по дням МСК.
  const leadsByDay = new Map<string, { total: number; fromDirect: number }>()
  try {
    // Верхняя граница окна ЭКСКЛюзивна (lt) + дедуп по телефону — чтобы delivered
    // и подневная сумма не расходились и один номер не считался дважды.
    const rawLeads = await getLeadsForPeriod(from, to, { exclusiveTo: true })
    const leads = dedupeLeadsByPhone(filterOutTestLeads(rawLeads))
    for (const lead of leads) {
      const d = mskDay(lead.createdAt)
      const cur = leadsByDay.get(d) ?? { total: 0, fromDirect: 0 }
      cur.total += 1
      leadsByDay.set(d, cur)
    }
    for (const lead of splitLeadsByOrigin(leads).fromDirect) {
      const d = mskDay(lead.createdAt)
      const cur = leadsByDay.get(d) ?? { total: 0, fromDirect: 0 }
      cur.fromDirect += 1
      leadsByDay.set(d, cur)
    }
  } catch (err) {
    console.error('[boris-direct/weekly] заявки за период недоступны', err)
  }

  // Per-query агрегаты недели (для лучших/худших) + Директ-атрибуция.
  const weekQueries = sqTsv ? parseReportTsv(sqTsv).map(toQueryStatRow) : []
  const directAttrib = weekQueries.reduce((acc, r) => acc + r.conversions, 0)
  const topWeekQueries = [...weekQueries]
    .sort((a, b) => b.clicks - a.clicks || b.costRub - a.costRub)
    .map((r) => ({ query: r.query, clicks: r.clicks, costRub: r.costRub, conversions: r.conversions }))

  const days: DailyReportData[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateLabel, t]) => {
      const leads = leadsByDay.get(dateLabel) ?? { total: 0, fromDirect: 0 }
      return {
        dateLabel,
        spendRub: t.spendRub,
        clicks: t.clicks,
        impressions: t.impressions,
        ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
        leadsTotal: leads.total,
        leadsFromDirect: leads.fromDirect,
        costPerLeadRub: leads.fromDirect > 0 ? t.spendRub / leads.fromDirect : null,
        topQueries: [],
        quarantine: false,
      }
    })

  // Недельные фразы вешаем на день с максимумом кликов (агрегатор best/worst
  // суммирует topQueries по всем дням — так они попадут в разбор без дублей).
  if (days.length > 0 && topWeekQueries.length > 0) {
    let peak = days[0]
    for (const d of days) if ((d.clicks ?? 0) > (peak.clicks ?? 0)) peak = d
    peak.topQueries = topWeekQueries
  }

  return { days, directAttrib, matchTypeShare }
}

async function handler(request: Request) {
  const now = new Date()
  const force = new URL(request.url).searchParams.get('force') === 'true'

  if (!force && mskWeekday(now) !== 1) {
    return NextResponse.json({ ok: true, skipped: 'not_monday' })
  }
  if (!force && (await alreadyRanToday(JOB_LABEL, now))) {
    return NextResponse.json({ ok: true, skipped: 'already_ran' })
  }

  // Период: последние 7 МСК-дней [сегодня-7 .. сегодня). Последний включённый день — вчера.
  const to = mskDayStartUtc(mskDay(now))
  const from = new Date(to.getTime() - 7 * DAY_MS)
  const fromDay = mskDay(from)
  const toDay = mskDay(new Date(to.getTime() - DAY_MS))

  // 1. Дни из отчётов за ВЕСЬ период (добор), фолбэк — снапшоты daily_result.
  let days: DailyReportData[] = []
  let directAttrib = 0
  let matchTypeShare: { synonymPct: number; synonymClicks: number; keywordClicks: number } | undefined
  try {
    const built = await buildDaysFromReports(fromDay, toDay, from, to)
    if (built) {
      days = built.days
      directAttrib = built.directAttrib
      matchTypeShare = built.matchTypeShare
    }
  } catch (err) {
    console.error('[boris-direct/weekly] сбор по отчётам не удался — фолбэк на снапшоты', err)
  }
  if (days.length === 0) {
    const snaps = await prisma.borisDirectSnapshot.findMany({
      where: { kind: 'daily_result', tickDate: { gte: from, lt: to } },
      orderBy: { createdAt: 'asc' },
    })
    const byDay = new Map<string, DailyReportData>()
    for (const snap of snaps) {
      const payload = snap.payload as unknown as DailyReportData
      if (payload?.dateLabel) byDay.set(payload.dateLabel, payload)
    }
    days = [...byDay.values()].sort((a, b) => a.dateLabel.localeCompare(b.dateLabel))
    directAttrib = days.reduce(
      (acc, d) => acc + d.topQueries.reduce((s, q) => s + q.conversions, 0),
      0
    )
  }

  // 2. Метрика (достижения цели) + Доставлено (БД, тест-фильтр) за период.
  let metrika = 0
  try {
    const goal = await getGoalStatsByDay(fromDay, toDay)
    metrika = goal.reduce((acc, g) => acc + g.goalReaches, 0)
  } catch (err) {
    console.error('[boris-direct/weekly] Метрика по дням недоступна', err)
  }
  let delivered = 0
  try {
    const leads = dedupeLeadsByPhone(filterOutTestLeads(await getLeadsForPeriod(from, to, { exclusiveTo: true })))
    delivered = splitLeadsByOrigin(leads).fromDirect.length
  } catch (err) {
    console.error('[boris-direct/weekly] заявки для «Доставлено» недоступны', err)
  }

  const llmSpend = await getLlmSpendForPeriod(from, to)
  const proposalsPending = await prisma.borisDirectProposal.count({ where: { status: 'PENDING' } })

  // М3: недорасход недели — медиана дневного расхода по РАБОЧИМ дням vs ЖИВОЙ бюджет.
  let underspendWeekly: { medianSpendRub: number; dailyBudgetRub: number } | undefined
  try {
    const workdaySpends = days
      .filter((d) => isWorkday(d.dateLabel) && d.spendRub != null)
      .map((d) => d.spendRub as number)
      .sort((a, b) => a - b)
    if (workdaySpends.length > 0) {
      const n = workdaySpends.length
      const medianSpendRub =
        n % 2 === 1 ? workdaySpends[(n - 1) / 2] : (workdaySpends[n / 2 - 1] + workdaySpends[n / 2]) / 2
      const campaignSnap = await prisma.borisDirectSnapshot.findFirst({
        where: { kind: 'campaign' },
        orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
      })
      const budgetMicro =
        (campaignSnap?.payload as { DailyBudget?: { Amount?: number } } | null)?.DailyBudget?.Amount ??
        DAILY_BUDGET_MICRO
      underspendWeekly = { medianSpendRub, dailyBudgetRub: budgetMicro / MICRO }
    }
  } catch (err) {
    console.error('[boris-direct/weekly] недорасход недели не посчитан', err)
  }

  // М5: выручка по сделкам (владелец отмечает командой) — за неделю и всего.
  // ТОЛЬКО видимость. Сбой не роняет отчёт (секции просто не будет).
  let revenue: { weekly: ReturnType<typeof aggregateRevenueByPhrase>; allTime: ReturnType<typeof aggregateRevenueByPhrase> } | undefined
  try {
    const deals = await getWonDeals(from, to)
    revenue = {
      weekly: aggregateRevenueByPhrase(deals.inPeriod),
      allTime: aggregateRevenueByPhrase(deals.all),
    }
  } catch (err) {
    console.error('[boris-direct/weekly] выручка по сделкам не посчитана', err)
  }

  // М5: «эффект первой порции» — когорта поднятых 10.07 vs портфель, до/после.
  // Read-only (ActionLog + 2 SQ-отчёта). Сбой/недозрев → блока просто не будет.
  let cohortEffect
  try {
    cohortEffect =
      (await getCohortEffect(UPLIFT_COHORT_RAISE_DAY, toDay, PHRASE_ECON_WINDOW_WORKDAYS, COHORT_MIN_CLICKS)) ??
      undefined
  } catch (err) {
    console.error('[boris-direct/weekly] эффект первой порции не посчитан', err)
  }

  const text = await generateWeeklyReportText(days, {
    llmSpendUsd: llmSpend.costUsd,
    llmCalls: llmSpend.calls,
    proposalsPending,
    period: { from: fromDay, to: toDay },
    leadCounts: { directAttrib, metrika, delivered, deliveredBlindBefore: DB_BLIND_BEFORE_MSK },
    matchTypeShare,
    underspendWeekly,
    revenue,
    cohortEffect,
  })

  // М4 ШАГ 2: недельный консилиум (heavy) — 3–5 гипотез владельцу ОТДЕЛЬНЫМ РАЗДЕЛОМ
  // недельного отчёта, СТРОГО текст (не в кабинет, не предложения-с-кнопками). Один
  // heavy-вызов в неделю. Fail-safe: любой сбой/пусто → '' → раздела нет, отчёт уходит.
  let lessonsDigest: string | undefined
  try {
    lessonsDigest = await getActiveLessonsReport()
  } catch (err) {
    console.error('[boris-direct/weekly] уроки для консилиума недоступны', err)
  }
  const consilium = await generateWeeklyConsilium({
    period: { from: fromDay, to: toDay },
    days: days.map((d) => ({
      dateLabel: d.dateLabel,
      spendRub: d.spendRub,
      clicks: d.clicks,
      leadsFromDirect: d.leadsFromDirect,
      costPerLeadRub: d.costPerLeadRub,
    })),
    topQueries: days.flatMap((d) => d.topQueries),
    leadCounts: { directAttrib, metrika, delivered },
    underspendWeekly,
    matchTypeShare,
    lessonsDigest,
  })

  // Память вопросов: гипотезы консилиума персистим (kind='consilium', статус open),
  // чтобы Борис мог вернуться к ним и проверить (фундамент рассуждающего контура —
  // аудит 14.07: выход консилиума нигде не хранился → петли гипотеза→проверка не было).
  // Fail-safe: сбой персиста не мешает отправке отчёта.
  try {
    await persistConsilium({ text: consilium, from: fromDay, to: toDay })
  } catch (err) {
    console.error('[boris-direct/weekly] персист консилиума не удался (не критично)', err)
  }

  const fullText = consilium ? `${text}\n\n${consilium}` : text
  const sent = await sendToDirectChat(fullText)

  await markRanToday(JOB_LABEL, { days: days.length, sent: sent.ok })

  return NextResponse.json({
    ok: true,
    period: { from: fromDay, to: toDay },
    days: days.length,
    leadCounts: { directAttrib, metrika, delivered },
    sent: sent.ok,
  })
}

export const GET = withCronHeartbeat(JOB_LABEL, handler)
