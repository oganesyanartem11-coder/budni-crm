/**
 * БЕЛЫЙ СПИСОК ПРОВЕРОК (рассуждающий контур, спринт 14.07).
 *
 * Аналитик СТАВИТ вопрос и назначает ему проверку из ЭТОГО реестра; следующий
 * process-тик её исполняет (executeCheck) и пишет вывод в память вопросов. НИКАКИХ
 * иных исполняемых действий из вопросов не бывает — ключ вне реестра тихо
 * возвращает inconclusive и НЕ трогает данные (жёсткий барьер: аналитик не может
 * «попросить» suspend/set/add — только читать и сравнивать).
 *
 * Все проверки READ-ONLY. Чистая логика вывода отделена от доступа к данным (deps):
 * evaluate* — детерминированные функции (TDD), executeCheck — тонкий диспетчер,
 * который через deps достаёт данные и зовёт нужный evaluate.
 */

import {
  FUNNEL_MIN_VISITS_DAY,
  LADDER_DRIFT_MEDIAN_PCT,
  LADDER_DRIFT_BELOW_ENTRY_PP,
  COHORT_MIN_CLICKS,
  DEVICE_SKEW_MIN_CLICKS,
  OUTCOME_WORSE_RATIO,
  OUTCOME_IMPROVED_RATIO,
  getLeadValueRub,
} from './config'
import type { AnalystCheckSpec } from './questions'

export const CHECK_KEYS = [
  'metrika_goal_series',
  'compare_query_windows',
  'ladder_medians',
  'cohort_economics',
  'device_geo_slice',
] as const
export type CheckKey = (typeof CHECK_KEYS)[number]

export function isWhitelistedCheck(key: string): key is CheckKey {
  return (CHECK_KEYS as readonly string[]).includes(key)
}

export type CheckStatus = 'confirmed' | 'refuted' | 'inconclusive'

export interface CheckOutcome {
  status: CheckStatus
  /** Вывод с цифрами (свежий замер из БД — источник правды сам по себе). */
  result: string
  /** Оценка эффекта в ₽ для гейта эскалации владельцу (0 = не оценивается). */
  effectRub: number
}

const round = (n: number): number => Math.round(n)

// ---------- 1) Серия цели Метрики по дням ----------

export interface GoalDay {
  day: string
  visits: number
  goalReaches: number
}

/** Мин. визитов в хвостовой серии, чтобы судить о нулях (иначе шум). */
const GOAL_SERIES_MIN_TRAIL_VISITS = 10

/**
 * Проверка гипотезы «нулевая серия заявок реальна». Хвостовая серия дней с 0 целей
 * при живых визитах → confirmed (с оценкой упущенных заявок × ценность). Цель в
 * хвосте есть → refuted. Мало визитов в хвосте → inconclusive.
 */
export function evaluateMetrikaGoalSeries(series: GoalDay[], params: { minVisitsDay?: number }): CheckOutcome {
  const minDay = params.minVisitsDay ?? FUNNEL_MIN_VISITS_DAY
  // Хвостовая серия нулей целей (день с целью обрывает).
  let trailDays = 0
  let trailVisits = 0
  for (let i = series.length - 1; i >= 0; i--) {
    const d = series[i]
    if (d.goalReaches > 0) break
    trailDays++
    if (d.visits >= minDay) trailVisits += d.visits
  }
  if (trailDays === 0) {
    return { status: 'refuted', result: 'В хвосте окна есть достижения цели — серии нулей нет.', effectRub: 0 }
  }
  if (trailVisits < GOAL_SERIES_MIN_TRAIL_VISITS) {
    return {
      status: 'inconclusive',
      result: `Хвостовая серия ${trailDays} дн., но всего ${trailVisits} визитов — мало для вывода.`,
      effectRub: 0,
    }
  }
  // Базовая CR по «здоровому» префиксу (дни до последней цели).
  let lastGoalIdx = -1
  for (let i = 0; i < series.length; i++) if (series[i].goalReaches > 0) lastGoalIdx = i
  let crVisits = 0
  let crGoals = 0
  for (let i = 0; i <= lastGoalIdx; i++) {
    crVisits += series[i].visits
    crGoals += series[i].goalReaches
  }
  const cr = crVisits > 0 && crGoals > 0 ? crGoals / crVisits : 0
  const expectedLost = cr * trailVisits
  const effectRub = round(expectedLost * getLeadValueRub())
  const crPct = cr > 0 ? (cr * 100).toFixed(1) : '—'
  return {
    status: 'confirmed',
    result:
      `Серия ${trailDays} дн. с 0 целей при ${trailVisits} живых визитах (историческая CR ${crPct}%). ` +
      `Ожидалось ~${round(expectedLost)} заявок — вероятная потеря ${effectRub} ₽.`,
    effectRub,
  }
}

// ---------- 2) Сравнение двух окон QueryDailyStat ----------

export interface QueryWindowAgg {
  clicks: number
  costRub: number
  conversions: number
}
export type CompareMetric = 'clicks' | 'costRub' | 'conversions' | 'cpl'

/** Порог значимого сдвига метрики между окнами (доля). */
const COMPARE_MIN_SHIFT = 0.3

function metricValue(a: QueryWindowAgg, metric: CompareMetric): number | null {
  if (metric === 'cpl') return a.conversions > 0 ? a.costRub / a.conversions : null
  return a[metric]
}

/**
 * Сравнить одну метрику в двух окнах (recent vs prior). Сдвиг ≥ COMPARE_MIN_SHIFT →
 * confirmed; меньше → refuted; база (prior) отсутствует/ноль → inconclusive.
 * effectRub — сдвиг расхода (для cost/cpl), иначе 0.
 */
export function evaluateCompareQueryWindows(
  recent: QueryWindowAgg,
  prior: QueryWindowAgg,
  params: { metric: CompareMetric }
): CheckOutcome {
  const m = params.metric
  const a = metricValue(recent, m)
  const b = metricValue(prior, m)
  if (b == null || b === 0 || a == null) {
    return { status: 'inconclusive', result: `Недостаточно базы для сравнения по «${m}».`, effectRub: 0 }
  }
  const deltaPct = (a - b) / b
  const dir = deltaPct >= 0 ? 'вырос' : 'упал'
  const effectRub = m === 'costRub' || m === 'cpl' ? round(Math.abs(recent.costRub - prior.costRub)) : 0
  const line = `«${m}» ${dir} на ${round(Math.abs(deltaPct) * 100)}% (${round(b)}→${round(a)}).`
  if (Math.abs(deltaPct) >= COMPARE_MIN_SHIFT) {
    return { status: 'confirmed', result: line, effectRub }
  }
  return { status: 'refuted', result: `Сдвиг мал: ${line}`, effectRub: 0 }
}

// ---------- 3) Медианы/below-entry лесенки за N дней ----------

export interface LadderDay {
  day: string
  entryMedianRub: number | null
  belowEntryPct: number | null
}

/**
 * Дрейф лесенки за окно: первый vs последний день. |Δ медианы| > LADDER_DRIFT_MEDIAN_PCT
 * ИЛИ рост доли ниже входа ≥ LADDER_DRIFT_BELOW_ENTRY_PP → confirmed. < 2 валидных
 * дней → inconclusive. Иначе refuted (вход стабилен — страх «протухли» не подтверждён).
 */
export function evaluateLadderMedians(perDay: LadderDay[], _params: Record<string, unknown>): CheckOutcome {
  const valid = perDay.filter((d) => d.entryMedianRub != null)
  if (valid.length < 2) {
    return { status: 'inconclusive', result: 'Меньше 2 дней с валидной лесенкой — сравнивать нечего.', effectRub: 0 }
  }
  const first = valid[0]
  const last = valid[valid.length - 1]
  const medianDeltaPct = (last.entryMedianRub! - first.entryMedianRub!) / first.entryMedianRub!
  const belowDeltaPp =
    first.belowEntryPct != null && last.belowEntryPct != null ? last.belowEntryPct - first.belowEntryPct : 0
  const trips = Math.abs(medianDeltaPct) > LADDER_DRIFT_MEDIAN_PCT || belowDeltaPp >= LADDER_DRIFT_BELOW_ENTRY_PP
  const dir = medianDeltaPct >= 0 ? 'вырос' : 'упал'
  const line = `медиана входа ${dir} на ${round(Math.abs(medianDeltaPct) * 100)}% (${round(first.entryMedianRub!)}→${round(last.entryMedianRub!)} ₽), ниже входа ${round(belowDeltaPp)} п.п.`
  return trips
    ? { status: 'confirmed', result: line, effectRub: 0 }
    : { status: 'refuted', result: `Вход стабилен: ${line}`, effectRub: 0 }
}

// ---------- 4) Экономика когорты фраз ----------

export interface CohortAgg {
  clicksBefore: number
  convBefore: number
  costBefore: number
  clicksAfter: number
  convAfter: number
  costAfter: number
}

/**
 * Экономика когорты «до/после». CPL после ≥ OUTCOME_WORSE_RATIO×до → confirmed(хуже);
 * ≤ OUTCOME_IMPROVED_RATIO×до → confirmed(лучше); между → refuted. Кликов меньше
 * COHORT_MIN_CLICKS в любом окне → inconclusive (честность). effectRub — сдвиг расхода.
 */
export function evaluateCohortEconomics(agg: CohortAgg, _params: Record<string, unknown>): CheckOutcome {
  if (agg.clicksBefore < COHORT_MIN_CLICKS || agg.clicksAfter < COHORT_MIN_CLICKS) {
    return { status: 'inconclusive', result: 'Кликов в когорте меньше минимума честности — вывод рано.', effectRub: 0 }
  }
  if (agg.convBefore === 0 || agg.convAfter === 0) {
    return { status: 'inconclusive', result: 'Нет заявок в одном из окон — цена заявки не считается.', effectRub: 0 }
  }
  const cplBefore = agg.costBefore / agg.convBefore
  const cplAfter = agg.costAfter / agg.convAfter
  const ratio = cplAfter / cplBefore
  const effectRub = round(Math.abs(agg.costAfter - agg.costBefore))
  const line = `цена заявки ${round(cplBefore)}→${round(cplAfter)} ₽ (×${ratio.toFixed(2)})`
  if (ratio >= OUTCOME_WORSE_RATIO) return { status: 'confirmed', result: `Стало хуже/дороже: ${line}.`, effectRub }
  if (ratio <= OUTCOME_IMPROVED_RATIO) return { status: 'confirmed', result: `Стало лучше: ${line}.`, effectRub }
  return { status: 'refuted', result: `Изменение в пределах шума: ${line}.`, effectRub: 0 }
}

// ---------- 5) device/гео-срез визитов ----------

export interface SliceRow {
  segment: string
  visits: number
  conv: number
}

/**
 * Срез визитов по устройству/гео: сегмент с объёмом (≥ DEVICE_SKEW_MIN_CLICKS
 * визитов) и нулём заявок → confirmed (утечка на неконвертящий сегмент, самый
 * объёмный). Иначе refuted. Все сегменты мелкие → inconclusive.
 */
export function evaluateDeviceGeoSlice(rows: SliceRow[], _params: Record<string, unknown>): CheckOutcome {
  const sizeable = rows.filter((r) => r.visits >= DEVICE_SKEW_MIN_CLICKS)
  if (sizeable.length === 0) {
    return { status: 'inconclusive', result: 'Все сегменты мельче порога — судить рано.', effectRub: 0 }
  }
  const waste = sizeable.filter((r) => r.conv === 0).sort((a, b) => b.visits - a.visits)
  if (waste.length > 0) {
    const w = waste[0]
    return {
      status: 'confirmed',
      result: `Сегмент «${w.segment}»: ${w.visits} визитов, 0 заявок — трафик не конвертит.`,
      effectRub: 0,
    }
  }
  return { status: 'refuted', result: 'Объёмные сегменты конвертят — явной утечки нет.', effectRub: 0 }
}

// ---------- Доступ к данным (DI) + диспетчер ----------

export interface CheckDeps {
  loadMetrikaGoalSeries(windowDays: number, now: Date): Promise<GoalDay[]>
  loadQueryWindowAgg(
    win: 'recent' | 'prior',
    windowDays: number,
    now: Date,
    filter?: { querySubstr?: string; adGroupId?: string }
  ): Promise<QueryWindowAgg>
  loadLadderPerDay(windowDays: number, now: Date): Promise<LadderDay[]>
  loadCohortRows(criterionIds: number[], raiseDay: string, windowDays: number, now: Date): Promise<CohortAgg>
  loadDeviceGeoSlice(dimension: 'device' | 'geo', windowDays: number, now: Date): Promise<SliceRow[]>
}

function num(params: Record<string, unknown>, key: string, def: number): number {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}
function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === 'string' ? v : undefined
}

const UNKNOWN: CheckOutcome = {
  status: 'inconclusive',
  result: 'Проверка вне белого списка — не исполняется (неизвестный ключ).',
  effectRub: 0,
}

/**
 * Исполнить назначенную проверку через deps. Ключ вне белого списка → UNKNOWN,
 * НИ ОДНОЙ deps-функции не зовём (барьер: аналитик не может протащить действие).
 * Любой сбой deps ловится вызывающим (analyst-cycle) — тут только диспетчеризация.
 */
export async function executeCheck(spec: AnalystCheckSpec, deps: CheckDeps, now: Date): Promise<CheckOutcome> {
  if (!isWhitelistedCheck(spec.key)) return UNKNOWN
  const p = spec.params ?? {}
  const windowDays = num(p, 'windowDays', 14)

  switch (spec.key) {
    case 'metrika_goal_series': {
      const series = await deps.loadMetrikaGoalSeries(windowDays, now)
      return evaluateMetrikaGoalSeries(series, { minVisitsDay: num(p, 'minVisitsDay', FUNNEL_MIN_VISITS_DAY) })
    }
    case 'compare_query_windows': {
      const filter = { querySubstr: str(p, 'querySubstr'), adGroupId: str(p, 'adGroupId') }
      const [recent, prior] = await Promise.all([
        deps.loadQueryWindowAgg('recent', windowDays, now, filter),
        deps.loadQueryWindowAgg('prior', windowDays, now, filter),
      ])
      const metric = (str(p, 'metric') as CompareMetric) || 'conversions'
      return evaluateCompareQueryWindows(recent, prior, { metric })
    }
    case 'ladder_medians': {
      const perDay = await deps.loadLadderPerDay(windowDays, now)
      return evaluateLadderMedians(perDay, p)
    }
    case 'cohort_economics': {
      const ids = Array.isArray(p.criterionIds) ? (p.criterionIds as unknown[]).map(Number).filter(Number.isFinite) : []
      const raiseDay = str(p, 'raiseDay') ?? ''
      const agg = await deps.loadCohortRows(ids, raiseDay, windowDays, now)
      return evaluateCohortEconomics(agg, p)
    }
    case 'device_geo_slice': {
      const dimension = str(p, 'dimension') === 'geo' ? 'geo' : 'device'
      const rows = await deps.loadDeviceGeoSlice(dimension, windowDays, now)
      return evaluateDeviceGeoSlice(rows, p)
    }
    default:
      return UNKNOWN
  }
}
