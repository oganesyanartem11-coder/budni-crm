/**
 * ОРКЕСТРАТОР рассуждающего контура (спринт 14.07). Живёт в РОУТЕ
 * (boris-direct-process), НЕ в мозг-тике → полигон его не исполняет (sim-нейтрально,
 * как forecast/detector-cycle). Раз в день замыкает петлю гипотеза→проверка→вывод:
 *
 *  1) ИСПОЛНИТЬ назначенные вчера проверки активных вопросов (белый список) →
 *     записать вывод; confirmed И эффект ≥ порога ₽ → эскалация владельцу.
 *  2) СОБРАТЬ дашборд → heavy-проход аналитика → 0–3 заземлённых вопроса дня
 *     (с cooldown тем) → память вопросов + секция «Аналитик: вопросы дня» владельцу.
 *
 * НИ ОДНОГО write в кабинет: только чтение, сравнение и текст. Фичефлаг
 * ANALYST_ENABLED (config): выключен → тихий скип (кроны живут, стоимость ноль).
 *
 * Логика петли (runAnalystCycle) вынесена под DI и покрыта TDD; прод-обвязка
 * (collectAnalystDashboard/realCheckDeps/runAnalystCycleProd) — тонкая I/O-склейка.
 */

import { prisma } from '@/lib/db/prisma'
import { mskDay, mskDayStartUtc } from './brain'
import { isWorkday, workdayWindowStartUtc } from './workdays'
import { sendToDirectChat } from './telegram'
import {
  isAnalystEnabled,
  ANALYST_ESCALATE_MIN_RUB,
  ANALYST_QUESTION_COOLDOWN_DAYS,
  ANALYST_DASHBOARD_WINDOW_DAYS,
  LADDER_DRIFT_WORKDAYS,
  UPLIFT_COHORT_RAISE_DAY,
} from './config'
import {
  getActiveQuestions,
  getLatestQuestions,
  createQuestion,
  updateQuestion,
  isTopicOnCooldown,
  type AnalystQuestion,
  type AnalystCheckSpec,
} from './questions'
import { runAnalystPass, type AnalystPassResult } from './analyst'
import {
  executeCheck,
  type CheckDeps,
  type CheckOutcome,
  type GoalDay,
  type QueryWindowAgg,
  type LadderDay,
  type CohortAgg,
  type SliceRow,
} from './analyst-checks'
import {
  buildAnalystDashboard,
  type AnalystDashboardInput,
  type AnalystWindowDay,
} from './analyst-dashboard'
import { loadForecastForDay, renderForecastLine } from './forecast'
import { summarizeLadderEntry, detectLadderDrift } from './ladder-drift'
import type { KeywordBidRecord } from './direct-client'
import { getLeadsForPeriod, splitLeadsByOrigin, dedupeLeadsByPhone } from './attribution'
import { filterOutTestLeads } from './test-markers'
import { getGoalStatsByDay, getGoalStatsByDevice } from './metrika-client'
import { getActiveLessonsReport } from './lessons'
import { getWonDeals, aggregateRevenueByPhrase } from './deals'
import { getDirectRoleState } from './state'

const DAY_MS = 24 * 60 * 60 * 1000

// ---------- Оркестратор под DI (TDD) ----------

export interface AnalystCycleDeps {
  isEnabled(): boolean
  now: Date
  getActive(): Promise<AnalystQuestion[]>
  getLatest(): Promise<AnalystQuestion[]>
  updateQuestion(
    id: string,
    patch: { status?: AnalystQuestion['status']; result?: string; escalatedMsk?: string },
    now: Date
  ): Promise<void>
  createQuestion(input: {
    question: string
    check: string
    now: Date
    topicKey?: string
    checkSpec?: AnalystCheckSpec
  }): Promise<void>
  executeSpec(spec: AnalystCheckSpec, now: Date): Promise<CheckOutcome>
  buildDashboard(): Promise<string>
  runPass(dashboardText: string): Promise<AnalystPassResult>
  /** Немедленная эскалация подтверждённой находки владельцу. */
  escalate(text: string): Promise<void>
  /** Секция «Аналитик: вопросы дня» владельцу (тишина — не зовём). */
  notify(text: string): Promise<void>
}

export interface AnalystCycleResult {
  skipped: false | 'disabled'
  checksRun: number
  confirmed: number
  escalated: number
  asked: number
  dropped: number
}

/** Короткая обрезка текста вопроса для сводок. */
function short(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export async function runAnalystCycle(deps: AnalystCycleDeps): Promise<AnalystCycleResult> {
  const res: AnalystCycleResult = { skipped: false, checksRun: 0, confirmed: 0, escalated: 0, asked: 0, dropped: 0 }
  if (!deps.isEnabled()) return { ...res, skipped: 'disabled' }

  const today = mskDay(deps.now)

  // --- 1) Исполнить назначенные проверки активных вопросов ---
  const active = await deps.getActive()
  for (const q of active) {
    if (!q.checkSpec) continue
    let outcome: CheckOutcome
    try {
      outcome = await deps.executeSpec(q.checkSpec, deps.now)
    } catch (err) {
      console.error(`[boris-direct/analyst-cycle] проверка вопроса ${q.id} упала (пропускаю)`, err)
      continue
    }
    res.checksRun++

    // inconclusive закрываем как refuted с пометкой — иначе вопрос переисполнялся бы вечно.
    const finalStatus: AnalystQuestion['status'] = outcome.status === 'inconclusive' ? 'refuted' : outcome.status
    const resultText = outcome.status === 'inconclusive' ? `неубедительно: ${outcome.result}` : outcome.result

    const doEscalate =
      outcome.status === 'confirmed' && outcome.effectRub >= ANALYST_ESCALATE_MIN_RUB && !q.escalatedMsk
    if (outcome.status === 'confirmed') res.confirmed++

    try {
      await deps.updateQuestion(
        q.id,
        { status: finalStatus, result: resultText, ...(doEscalate ? { escalatedMsk: today } : {}) },
        deps.now
      )
    } catch (err) {
      console.error(`[boris-direct/analyst-cycle] запись итога вопроса ${q.id} упала`, err)
    }

    if (doEscalate) {
      try {
        await deps.escalate(
          `🔎 <b>Аналитик подтвердил</b>: ${short(q.question)}\n${outcome.result}\n` +
            `Предлагаю обсудить шаг (это вывод-предложение, не действие — в кабинет ничего не менял).`
        )
        res.escalated++
      } catch (err) {
        console.error(`[boris-direct/analyst-cycle] эскалация вопроса ${q.id} не ушла`, err)
      }
    }
  }

  // --- 2) Собрать дашборд → heavy-проход → новые вопросы дня ---
  let pass: AnalystPassResult
  try {
    const dashboard = await deps.buildDashboard()
    pass = await deps.runPass(dashboard)
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] сбор дашборда/проход аналитика упал', err)
    return res
  }
  res.dropped = pass.dropped.length
  for (const d of pass.dropped) {
    console.log(`[boris-direct/analyst-cycle] драфт отброшен (${d.reason}): ${d.detail}`)
  }

  const latest = await deps.getLatest()
  const askedTopics = new Set<string>()
  const askedLines: string[] = []
  for (const draft of pass.kept) {
    const topic = draft.topicKey
    if (askedTopics.has(topic)) continue // дубль темы в одном проходе
    if (isTopicOnCooldown(latest, topic, today, ANALYST_QUESTION_COOLDOWN_DAYS)) continue
    askedTopics.add(topic)
    try {
      await deps.createQuestion({
        question: draft.question,
        check: draft.check,
        topicKey: topic,
        checkSpec: draft.checkSpec,
        now: deps.now,
      })
      askedLines.push(`• ${short(draft.question)}`)
      res.asked++
    } catch (err) {
      console.error(`[boris-direct/analyst-cycle] создание вопроса (${topic}) упало`, err)
    }
  }

  if (askedLines.length > 0) {
    try {
      await deps.notify(`🔍 <b>Аналитик: вопросы дня</b> (${today})\n${askedLines.join('\n')}`)
    } catch (err) {
      console.error('[boris-direct/analyst-cycle] секция вопросов дня не ушла', err)
    }
  }

  return res
}

// ---------- Прод-обвязка: дашборд-сборщик (I/O, fail-safe по блокам) ----------

const round = (n: number): number => Math.round(n)

/** Снапшот kind (последний или ≤ atOrBefore). */
async function snapshotPayload<T>(kind: string, atOrBefore?: Date): Promise<T | null> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: atOrBefore ? { kind, tickDate: { lte: atOrBefore } } : { kind },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  return snap ? (snap.payload as unknown as T) : null
}

interface DailyTotalsSnap {
  date: string
  spendRub: number
  clicks: number
  impressions: number
}

/** Окно daily_totals → карта день→{spend,clicks}. */
async function loadDailyTotals(fromTick: Date, toTick: Date): Promise<Map<string, DailyTotalsSnap>> {
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'daily_totals', tickDate: { gte: fromTick, lte: toTick } },
    orderBy: { createdAt: 'asc' },
  })
  const byDay = new Map<string, DailyTotalsSnap>()
  for (const s of snaps) {
    const p = s.payload as unknown as DailyTotalsSnap
    if (p?.date) byDay.set(p.date, p)
  }
  return byDay
}

export interface CollectAnalystDashboardOpts {
  detectorAlerts?: string[]
}

/**
 * Собрать текст дашборда аналитика из БД/снапшотов. Каждый блок в своём try/catch:
 * недоступность одного не роняет остальные (аналитик получит частичный, но честный
 * срез). Все числа — из БД/снапшотов/готовых грунт-модулей.
 */
export async function collectAnalystDashboard(now: Date, opts: CollectAnalystDashboardOpts = {}): Promise<string> {
  const today = mskDay(now)
  const yesterday = mskDay(new Date(mskDayStartUtc(today).getTime() - DAY_MS))
  const state = await getDirectRoleState().catch(() => ({ mode: 'OBSERVE', frozen: false }) as { mode: string; frozen: boolean })

  const input: AnalystDashboardInput = {
    today,
    mode: state.mode,
    frozen: state.frozen,
    window: { days: [] },
    detectorAlerts: opts.detectorAlerts && opts.detectorAlerts.length > 0 ? opts.detectorAlerts : undefined,
  }

  // Блок 1: окно дней (расход/клики из daily_totals + заявки Директа из БД + CPL).
  try {
    const toTick = mskDayStartUtc(yesterday)
    const fromTick = new Date(toTick.getTime() - (ANALYST_DASHBOARD_WINDOW_DAYS - 1) * DAY_MS)
    const totals = await loadDailyTotals(fromTick, toTick)
    const leadsByDay = new Map<string, number>()
    try {
      const from = fromTick
      const to = new Date(toTick.getTime() + DAY_MS)
      const leads = dedupeLeadsByPhone(filterOutTestLeads(await getLeadsForPeriod(from, to, { exclusiveTo: true })))
      for (const l of splitLeadsByOrigin(leads).fromDirect) {
        const d = mskDay(l.createdAt)
        leadsByDay.set(d, (leadsByDay.get(d) ?? 0) + 1)
      }
    } catch (err) {
      console.error('[boris-direct/analyst-cycle] заявки по дням недоступны', err)
    }
    const days: AnalystWindowDay[] = [...totals.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((t) => {
        const leads = leadsByDay.get(t.date) ?? 0
        return {
          date: t.date,
          spendRub: round(t.spendRub ?? 0),
          clicks: t.clicks ?? 0,
          leads,
          cplRub: leads > 0 ? round((t.spendRub ?? 0) / leads) : null,
        }
      })
    input.window.days = days
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] окно дней не собрано', err)
  }

  // Блок 2: прогноз@вчера vs факт@вчера.
  try {
    const fcast = await loadForecastForDay(yesterday)
    const actualSnap = await prisma.borisDirectSnapshot.findFirst({
      where: { kind: 'daily_totals', tickDate: mskDayStartUtc(yesterday) },
      orderBy: { createdAt: 'desc' },
    })
    const actual = actualSnap ? (actualSnap.payload as unknown as DailyTotalsSnap) : null
    const line = renderForecastLine(fcast, { clicks: actual?.clicks ?? 0, spendRub: actual?.spendRub ?? 0 })
    if (line) input.forecast = { line }
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] прогноз не собран', err)
  }

  // Блок 3: лесенка (медиана входа + дрейф за LADDER_DRIFT_WORKDAYS раб. дней).
  try {
    const todayBids = await snapshotPayload<KeywordBidRecord[]>('keywordbids')
    if (todayBids) {
      const cur = summarizeLadderEntry(todayBids)
      const pastTick = workdayWindowStartUtc(today, LADDER_DRIFT_WORKDAYS)
      const pastBids = await snapshotPayload<KeywordBidRecord[]>('keywordbids', pastTick)
      let driftMedianPct: number | null | undefined
      let driftBelowEntryPp: number | null | undefined
      if (pastBids) {
        const drift = detectLadderDrift({ today: cur, past: summarizeLadderEntry(pastBids) })
        driftMedianPct = drift.medianDeltaPct
        driftBelowEntryPp = drift.belowEntryDeltaPp
      }
      input.ladder = {
        entryMedianRub: cur.entryMedianRub,
        belowEntryPct: cur.belowEntryPct,
        phrases: cur.phrases,
        driftMedianPct,
        driftBelowEntryPp,
      }
    }
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] лесенка не собрана', err)
  }

  // Блок 5: статусы (режим/гейт/предложения) — грунтованные строки.
  try {
    const pending = await prisma.borisDirectProposal.count({ where: { status: 'PENDING' } })
    const st = await getDirectRoleState()
    input.statuses = {
      lines: [
        `режим ${st.mode}${st.frozen ? ', заморозка' : ''}, авто-минуса ${st.autoNegativesEnabled ? 'вкл' : 'выкл'}`,
        `открытых предложений владельцу: ${pending}`,
      ],
    }
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] статусы не собраны', err)
  }

  // Блок 7: активные вопросы прошлых дней.
  try {
    input.activeQuestions = await getActiveQuestions()
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] активные вопросы не прочитаны', err)
  }

  // Блок 8: уроки.
  try {
    const lessons = await getActiveLessonsReport()
    if (lessons && lessons.trim()) input.lessons = lessons.trim()
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] уроки не собраны', err)
  }

  // Блок 9: деньги (выручка по сделкам за окно + всего).
  try {
    const from = new Date(mskDayStartUtc(today).getTime() - ANALYST_DASHBOARD_WINDOW_DAYS * DAY_MS)
    const deals = await getWonDeals(from, mskDayStartUtc(today))
    const week = aggregateRevenueByPhrase(deals.inPeriod)
    if (week.totalRevenue > 0 || week.dealCount > 0) {
      input.money = { lines: [`выручка окна: ${round(week.totalRevenue)} ₽ по ${week.dealCount} сделкам`] }
    }
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] деньги не собраны', err)
  }

  // Блок 11: открытый консилиум.
  try {
    const cons = await snapshotPayload<{ text?: string; status?: string }>('consilium')
    if (cons?.text && cons.status === 'open') {
      input.consilium = cons.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8)
    }
  } catch (err) {
    console.error('[boris-direct/analyst-cycle] консилиум не прочитан', err)
  }

  return buildAnalystDashboard(input)
}

// ---------- Прод-обвязка: read-only доступ к данным для белого списка ----------

/** МСК-день строки Decimal/Date → число ₽. */
function decRub(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Реальные deps белого списка — все запросы READ-ONLY (prisma find/aggregate,
 * Метрика read). Никаких вызовов Директа на запись. Окна считаются от `now`.
 */
export function buildRealCheckDeps(): CheckDeps {
  return {
    async loadMetrikaGoalSeries(windowDays, now): Promise<GoalDay[]> {
      const today = mskDay(now)
      const from = mskDay(new Date(mskDayStartUtc(today).getTime() - windowDays * DAY_MS))
      const to = mskDay(new Date(mskDayStartUtc(today).getTime() - DAY_MS))
      const rows = await getGoalStatsByDay(from, to)
      return rows.map((r) => ({ day: r.date, visits: r.visits, goalReaches: r.goalReaches }))
    },
    async loadQueryWindowAgg(win, windowDays, now, filter): Promise<QueryWindowAgg> {
      const today = mskDayStartUtc(mskDay(now))
      // recent = [today-window..today); prior = [today-2*window..today-window).
      const end = win === 'recent' ? today : new Date(today.getTime() - windowDays * DAY_MS)
      const start = new Date(end.getTime() - windowDays * DAY_MS)
      const rows = await prisma.borisDirectQueryDailyStat.findMany({
        where: {
          date: { gte: start, lt: end },
          ...(filter?.adGroupId ? { adGroupId: filter.adGroupId } : {}),
          ...(filter?.querySubstr ? { query: { contains: filter.querySubstr } } : {}),
        },
      })
      let clicks = 0
      let costRub = 0
      let conversions = 0
      for (const r of rows) {
        clicks += r.clicks
        costRub += decRub(r.costRub)
        conversions += r.conversions
      }
      return { clicks, costRub, conversions }
    },
    async loadLadderPerDay(windowDays, now): Promise<LadderDay[]> {
      const today = mskDay(now)
      const fromTick = new Date(mskDayStartUtc(today).getTime() - windowDays * DAY_MS)
      const snaps = await prisma.borisDirectSnapshot.findMany({
        where: { kind: 'keywordbids', tickDate: { gte: fromTick, lte: mskDayStartUtc(today) } },
        orderBy: { tickDate: 'asc' },
      })
      // По одному снапшоту на день (последний за день).
      const byDay = new Map<string, LadderDay>()
      for (const s of snaps) {
        const day = mskDay(s.tickDate)
        const sum = summarizeLadderEntry((s.payload as unknown as KeywordBidRecord[]) ?? [])
        byDay.set(day, { day, entryMedianRub: sum.entryMedianRub, belowEntryPct: sum.belowEntryPct })
      }
      return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
    },
    async loadCohortRows(criterionIds, raiseDay, windowDays, now): Promise<CohortAgg> {
      // Когорта по CriterionId недоступна в QueryDailyStat (ключ — текст запроса), но
      // окна до/после дня подъёма считаем по всему портфелю QueryDailyStat как грубую
      // рамку; точную когорту по CriterionId закрывает cohorts.ts в weekly. Здесь —
      // портфельная экономика до/после raiseDay (честная рамка для гипотезы).
      void criterionIds
      const raise = raiseDay ? mskDayStartUtc(raiseDay) : mskDayStartUtc(UPLIFT_COHORT_RAISE_DAY)
      const beforeStart = new Date(raise.getTime() - windowDays * DAY_MS)
      const afterEnd = new Date(raise.getTime() + windowDays * DAY_MS)
      const rows = await prisma.borisDirectQueryDailyStat.findMany({
        where: { date: { gte: beforeStart, lt: afterEnd } },
      })
      const agg: CohortAgg = { clicksBefore: 0, convBefore: 0, costBefore: 0, clicksAfter: 0, convAfter: 0, costAfter: 0 }
      for (const r of rows) {
        const after = r.date.getTime() >= raise.getTime()
        if (after) {
          agg.clicksAfter += r.clicks
          agg.convAfter += r.conversions
          agg.costAfter += decRub(r.costRub)
        } else {
          agg.clicksBefore += r.clicks
          agg.convBefore += r.conversions
          agg.costBefore += decRub(r.costRub)
        }
      }
      return agg
    },
    async loadDeviceGeoSlice(dimension, windowDays, now): Promise<SliceRow[]> {
      const today = mskDay(now)
      const from = mskDay(new Date(mskDayStartUtc(today).getTime() - windowDays * DAY_MS))
      const to = mskDay(new Date(mskDayStartUtc(today).getTime() - DAY_MS))
      if (dimension === 'device') {
        const rows = await getGoalStatsByDevice(from, to)
        return rows.map((r) => ({ segment: r.device, visits: r.visits, conv: r.goalReaches }))
      }
      // Гео-срез Метрики отдельным ключом не заводим в этом спринте — device достаточно
      // для дыры аудита; гео закрывает geo.ts в мозг-тике. Возвращаем пусто (inconclusive).
      return []
    },
  }
}

// ---------- Прод-точка входа (зовётся из cron-роута) ----------

/**
 * Прод-прогон рассуждающего контура. Собирает реальные deps и зовёт runAnalystCycle.
 * Fail-safe целиком: любой сбой логируется, тик живёт (вызывающий тоже в try/catch).
 */
export async function runAnalystCycleProd(
  now: Date = new Date(),
  opts: CollectAnalystDashboardOpts = {}
): Promise<AnalystCycleResult> {
  const checkDeps = buildRealCheckDeps()
  return runAnalystCycle({
    isEnabled: isAnalystEnabled,
    now,
    getActive: getActiveQuestions,
    getLatest: getLatestQuestions,
    updateQuestion,
    createQuestion,
    executeSpec: (spec, at) => executeCheck(spec, checkDeps, at),
    buildDashboard: () => collectAnalystDashboard(now, opts),
    runPass: runAnalystPass,
    escalate: async (text) => {
      await sendToDirectChat(text)
    },
    notify: async (text) => {
      await sendToDirectChat(text)
    },
  })
}

// isWorkday импортируется на будущее (тип дня в срезах) — тихий ре-экспорт не нужен.
void isWorkday
