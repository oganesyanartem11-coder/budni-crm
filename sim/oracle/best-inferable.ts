/**
 * «ЛУЧШИЙ ВЫВОД ИЗ НАБЛЮДАЕМОГО» — консервативная диагностика идеального
 * аналитика полигона Бориса-Директа.
 *
 * В отличие от оракула (oracle.ts), который знает правду мира, здесь всё
 * выводится ТОЛЬКО из наблюдаемого (DayObservables) + конфиг кампании (фразы,
 * группы — чтобы относить запросы к фразам). Правило одно на всех: лучше
 * промолчать, чем ошибиться. Поэтому пороги высокие, а сигналы — устойчивые
 * (несколько дней, а не один всплеск). Это вспомогательная диагностика для
 * отчёта разбора ошибок: меньше кодов, но каждый — заслуженный.
 *
 * Ключи результата — как у скорера: 'campaign' | 'adgroup:<id>' | 'keyword:<id>'.
 */

import type { DayObservables, ReasonCode, ScenarioConfig } from '../types'

// ============================================================
// Именованные пороги (консервативные)
// ============================================================

/** BOT_TRAFFIC: столько кликов по фразе накоплено суммарно. */
const BOT_CLICKS_MIN = 20
/** BOT_TRAFFIC: визитов Метрики по запросу не больше этой доли кликов. */
const BOT_VISIT_RATIO_MAX = 0.1
/** Сколько дней подряд/суммарно должен держаться сигнал, чтобы поверить. */
const MIN_SIGNAL_DAYS = 3
/** FORM_DROPOFF: доля дошедших до формы не ниже. */
const FORM_REACH_MIN = 0.25
/** FORM_DROPOFF: визитов за день больше этого (иначе мало данных). */
const FORM_VISITS_MIN = 30
/** AD_TEXT_PROBLEM: CTR группы ниже этой доли медианы групп. */
const AD_TEXT_CTR_FACTOR = 0.5
/** AD_TEXT_PROBLEM: позиция «нормальная» — достигнутый TV не ниже. */
const AD_TEXT_TV_MIN = 65
/** POSITION_TOO_LOW: показов у фразы не больше этого (≈ ноль). */
const POSITION_IMP_MAX = 1
/** REGIME_CHANGE: показы поздней недели ниже этой доли первой недели. */
const REGIME_DROP_FACTOR = 0.4

// ============================================================
// Помощники
// ============================================================

function medianOf(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** Достигнутый TV каждой группы в наблюдаемом дне (медиана по её фразам). */
function groupAchievedTv(obs: DayObservables): Map<string, number> {
  const perGroup = new Map<string, number[]>()
  for (const kb of obs.keywordBids) {
    let tv = 0
    for (const a of kb.auction) if (a.priceMicro <= kb.bidMicro) tv = Math.max(tv, a.tv)
    const arr = perGroup.get(kb.adGroupId) ?? []
    arr.push(tv)
    perGroup.set(kb.adGroupId, arr)
  }
  const out = new Map<string, number>()
  for (const [g, arr] of perGroup) out.set(g, medianOf(arr))
  return out
}

/** Ставки не менялись за прогон, если bidMicro каждой фразы постоянен по дням. */
function bidsStable(days: DayObservables[]): boolean {
  const seen = new Map<number, number>()
  for (const d of days) {
    for (const kb of d.keywordBids) {
      const prev = seen.get(kb.keywordId)
      if (prev === undefined) seen.set(kb.keywordId, kb.bidMicro)
      else if (prev !== kb.bidMicro) return false
    }
  }
  return true
}

// ============================================================
// Главный вход
// ============================================================

export function inferCauseCodes(days: DayObservables[], config: ScenarioConfig): Record<string, ReasonCode> {
  const out: Record<string, ReasonCode> = {}
  if (days.length === 0) return out
  const last = days[days.length - 1]
  const rows = last.queryRows // queryRows кумулятивны — последний день содержит всю историю

  // Суммарные клики и показы по тексту запроса (по всей истории прогона).
  const clicksByText = new Map<string, number>()
  const impByText = new Map<string, number>()
  for (const r of rows) {
    clicksByText.set(r.query, (clicksByText.get(r.query) ?? 0) + r.clicks)
    impByText.set(r.query, (impByText.get(r.query) ?? 0) + r.impressions)
  }
  // Визиты Метрики по utm_term (== текст запроса) по всем дням.
  const visitsByTerm = new Map<string, number>()
  for (const d of days) {
    for (const u of d.metrikaByUtm) visitsByTerm.set(u.utmTerm, (visitsByTerm.get(u.utmTerm) ?? 0) + u.visits)
  }

  // ---------- Правило 1: BOT_TRAFFIC (фраза) ----------
  // Клики фразы (её собственный текст) ≥ 20 при почти нулевых визитах Метрики
  // по этому запросу: платим за клики, которых в Метрике нет — это боты.
  for (const p of config.phrases) {
    const clicks = clicksByText.get(p.text) ?? 0
    const visits = visitsByTerm.get(p.text) ?? 0
    if (clicks >= BOT_CLICKS_MIN && visits <= clicks * BOT_VISIT_RATIO_MAX) {
      out[`keyword:${p.keywordId}`] = 'BOT_TRAFFIC'
    }
  }

  // ---------- Правило 2: FORM_DROPOFF (кампания) ----------
  // ≥3 дней: до формы доходят (formReachRate≥0.25) при достаточных визитах
  // (>30), но целей ноль — качественный трафик отваливается на форме/оффере.
  let formDays = 0
  for (const d of days) {
    if (d.metrika.formReachRate >= FORM_REACH_MIN && d.metrika.goalReaches === 0 && d.metrika.visits > FORM_VISITS_MIN) {
      formDays++
    }
  }
  if (formDays >= MIN_SIGNAL_DAYS && !('campaign' in out)) out['campaign'] = 'FORM_DROPOFF'

  // ---------- Правило 3: AD_TEXT_PROBLEM (группа) ----------
  // ≥3 дней CTR группы < 50% медианы групп ПРИ достигнутом TV≥65 (позиция ок):
  // низкий CTR не из-за позиции — вопрос к текстам.
  const lowCtrDays = new Map<string, number>()
  for (const d of days) {
    const dayRows = rows.filter((r) => r.day === d.day)
    const perGroup = new Map<string, { clicks: number; imp: number }>()
    for (const r of dayRows) {
      const g = perGroup.get(r.adGroupId) ?? { clicks: 0, imp: 0 }
      g.clicks += r.clicks
      g.imp += r.impressions
      perGroup.set(r.adGroupId, g)
    }
    const ctrs: Array<{ g: string; ctr: number }> = []
    for (const [g, v] of perGroup) if (v.imp > 0) ctrs.push({ g, ctr: v.clicks / v.imp })
    if (ctrs.length < 2) continue // сравнивать не с чем
    const median = medianOf(ctrs.map((c) => c.ctr))
    const tvByGroup = groupAchievedTv(d)
    for (const { g, ctr } of ctrs) {
      const tv = tvByGroup.get(g) ?? 0
      if (tv >= AD_TEXT_TV_MIN && ctr < median * AD_TEXT_CTR_FACTOR) {
        lowCtrDays.set(g, (lowCtrDays.get(g) ?? 0) + 1)
      }
    }
  }
  for (const [g, cnt] of lowCtrDays) if (cnt >= MIN_SIGNAL_DAYS) out[`adgroup:${g}`] = 'AD_TEXT_PROBLEM'

  // ---------- Правило 4: POSITION_TOO_LOW (фраза) ----------
  // Ставка ниже цены минимального уровня TV15 и показов ≈ 0: позиция не берётся,
  // вопрос к ставке (а не к текстам/минусам).
  for (const kb of last.keywordBids) {
    const tv15 = kb.auction.find((a) => a.tv === 15)
    if (!tv15) continue
    if (kb.bidMicro < tv15.priceMicro) {
      const p = config.phrases.find((ph) => ph.keywordId === kb.keywordId)
      const imp = p ? (impByText.get(p.text) ?? 0) : 0
      if (imp <= POSITION_IMP_MAX && !(`keyword:${kb.keywordId}` in out)) {
        out[`keyword:${kb.keywordId}`] = 'POSITION_TOO_LOW'
      }
    }
  }

  // ---------- Правило 5: REGIME_CHANGE (кампания) ----------
  // Показы кампании упали >60% против первой недели при НЕИЗМЕННЫХ ставках:
  // мир сменился, прежняя картина устарела.
  const impByDay = days.map((d) => d.impressionsToday)
  const firstWeek = impByDay.slice(0, Math.min(7, impByDay.length))
  const lateWindow = impByDay.slice(Math.max(0, impByDay.length - 7))
  const fwMean = mean(firstWeek)
  const lateMean = mean(lateWindow)
  if (fwMean > 0 && lateMean < fwMean * REGIME_DROP_FACTOR && bidsStable(days) && !('campaign' in out)) {
    out['campaign'] = 'REGIME_CHANGE'
  }

  return out
}
