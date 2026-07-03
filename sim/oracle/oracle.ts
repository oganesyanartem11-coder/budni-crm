/**
 * ОРАКУЛ полигона Бориса-Директа — эталонные вердикты «как надо».
 *
 * Оракул считает экономику ЗЕРКАЛЬНО движку (sim/engine/world.ts), но по
 * МАТ-ОЖИДАНИЯМ: шум (±20% показов, ±10% цены, биномиальные клики) он
 * отбрасывает и работает с ожидаемыми величинами. Так получается стабильный,
 * детерминированный эталон, с которым скорер сравнивает игру Бориса/ботов.
 *
 * Правда мира (WorldTruth) оракулу доступна — он на то и оракул. Наружу (в
 * фейки транспорта) отсюда не уходит ничего.
 *
 * Экспорт (имена фиксированы — на них ссылается sim/runner/core.ts):
 *  - computeOracleVerdicts(config, opts?) → OracleVerdicts
 *  - computeAttributionReferences(world) → { omniscient, inferable }
 */

import type {
  OracleVerdicts,
  PhraseSpec,
  ReasonCode,
  ScenarioConfig,
  WorldState,
} from '../types'
import { leadKey } from '../types'

// ============================================================
// Именованные пороги (все «магические числа» — здесь)
// ============================================================

/** Бинарная шкала уровней TrafficVolume аукциона Директа (как в движке). */
const TV_LEVELS = [15, 65, 75, 85, 100] as const
/** Уровни, из которых оракул выбирает оптимум (премиум 85/100 не используется). */
const TV_CANDIDATES = [15, 65, 75] as const
/** Знаменатель охвата уровня: показы фразы масштабируются как (tv / 75). */
const TV_REACH_DENOM = 75
/** Железный потолок ставки Бориса, руб: вход дороже — уровень исключается. */
const BID_CEILING_RUB = 400
/** Мусор с ожидаемым расходом за прогон ≥ этого (руб) обязателен к минусу. */
const MUSTMINUS_MIN_SPEND_RUB = 100
/** Фраза «лид-позитивна» на уровне, если ожидает ≥ этого числа заявок за прогон. */
const LEAD_POSITIVE_MIN = 0.5
/** Качество группы, у которой ВСЕ объявления отклонены (зеркало движка). */
const ALL_REJECTED_QUALITY = 0.6
/** Микроединицы: 1 ₽ = 10^6 микро. */
const MICRO_PER_RUB = 1_000_000

// ============================================================
// Чистые утилиты (зеркало формул движка)
// ============================================================

/** Кламп в [0, 1] с защитой от NaN/Infinity. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.min(1, Math.max(0, x))
}

/**
 * Истинный CTR фразы на уровне tv — ТОЧНО как ctrForTv в движке: точное
 * значение из trueCtrByTv, иначе ближайший заданный уровень снизу, иначе
 * минимальный заданный (защита от дырявых конфигов).
 */
function ctrForTv(phrase: PhraseSpec, tv: number): number {
  const exact = phrase.trueCtrByTv[tv]
  if (Number.isFinite(exact)) return clamp01(exact)
  const defined = TV_LEVELS.filter((l) => Number.isFinite(phrase.trueCtrByTv[l]))
  if (!defined.length) return 0
  const below = defined.filter((l) => l <= tv)
  const level = below.length ? below[below.length - 1] : defined[0]
  return clamp01(phrase.trueCtrByTv[level])
}

/**
 * Качество текстов группы на день — зеркало adQualityFor движка: среднее
 * textQuality неотклонённых объявлений; все отклонены → 0.6; объявлений нет → 1.
 */
function adQualityFor(config: ScenarioConfig, adGroupId: string, day: number): number {
  const groupAds = config.ads.filter((a) => a.adGroupId === adGroupId)
  if (!groupAds.length) return 1
  const active = groupAds.filter((a) => a.rejectedFromDay === null || a.rejectedFromDay > day)
  if (!active.length) return ALL_REJECTED_QUALITY
  const sum = active.reduce((acc, a) => acc + (Number.isFinite(a.textQuality) ? a.textQuality : 1), 0)
  return sum / active.length
}

/**
 * Достигнутый уровень TV по ставке — зеркало аукциона движка: максимальный
 * уровень, чья цена (cpcByTv[l] × drift, в микро) ≤ ставке; ниже самого
 * дешёвого → 0 (нет показов).
 */
function achievedTv(bidMicro: number, cpcByTv: Record<number, number>, drift = 1): number {
  let tv = 0
  for (const l of TV_LEVELS) {
    const base = cpcByTv[l]
    if (!Number.isFinite(base)) continue
    const priceMicro = Math.round(base * MICRO_PER_RUB * drift)
    if (priceMicro <= bidMicro) tv = Math.max(tv, l)
  }
  return tv
}

// ============================================================
// Множители дня по фазе (зеркало событий движка)
// ============================================================

/** Множители дня, влияющие на экономику фразы (без недельной сезонности и качества). */
interface DayFactors {
  /** Множитель цены аукциона (auction_drift, накопительно). */
  drift: number
  /** Множитель спроса (demand_dip в его окне). */
  demandMult: number
  /** Множитель расхода внутри дня (intraday_budget_runaway). */
  runaway: number
  /** Множитель CTR ядра (competitor_brand_attack). */
  ctrMultCore: number
  /** Форма сломана в этот день (form_break без form_fix) — заявки в ноль. */
  formBroken: boolean
  /** Множитель CR группы (regime_change). */
  crMultOf(adGroupId: string): number
}

/** Фактическое состояние мира на день `day` (для фазы 'blend'). */
function blendFactorsAt(config: ScenarioConfig, day: number): DayFactors {
  let drift = 1
  let demandMult = 1
  let runaway = 1
  let ctrMultCore = 1
  let formBroken = false
  const crMap = new Map<string, number>()
  // События применяются в порядке расписания; .set перезаписывает (как в движке).
  for (const ev of config.events) {
    switch (ev.kind) {
      case 'auction_drift':
        if (ev.day <= day) drift *= ev.priceMultiplier
        break
      case 'demand_dip':
        if (day >= ev.day && day < ev.day + ev.days) demandMult *= ev.multiplier
        break
      case 'intraday_budget_runaway':
        if (ev.day === day) runaway *= ev.multiplier
        break
      case 'competitor_brand_attack':
        if (ev.day <= day) ctrMultCore = ev.ctrMultiplierCore
        break
      case 'regime_change':
        if (ev.day <= day) crMap.set(ev.adGroupId, ev.newCrMultiplier)
        break
      case 'form_break':
        if (ev.day <= day) formBroken = true
        break
      case 'form_fix':
        if (ev.day <= day) formBroken = false
        break
      default:
        break
    }
  }
  return { drift, demandMult, runaway, ctrMultCore, formBroken, crMultOf: (g) => crMap.get(g) ?? 1 }
}

/**
 * Фабрика множителей по фазе:
 *  - 'pre'  — мир ДО первого события (базовая калибровка, дрейф 1, CR ×1…);
 *  - 'post' — мир ПОСЛЕ последнего события (накопленный дрейф, финальные CR/CTR
 *    групп; транзиентные demand_dip/runaway/сезонная яма уже прошли);
 *  - 'blend'— фактическая траектория дня (по blendFactorsAt).
 * Недельная сезонность и качество объявлений считаются отдельно, по каждому дню.
 */
function phaseFactors(config: ScenarioConfig, phase: 'pre' | 'post' | 'blend'): (day: number) => DayFactors {
  if (phase === 'pre') {
    const base: DayFactors = {
      drift: 1,
      demandMult: 1,
      runaway: 1,
      ctrMultCore: 1,
      formBroken: false,
      crMultOf: () => 1,
    }
    return () => base
  }
  if (phase === 'post') {
    // Финал = состояние последнего дня, но без транзиентных провалов/катастроф.
    const finalDay = blendFactorsAt(config, config.days - 1)
    const post: DayFactors = {
      drift: finalDay.drift,
      demandMult: 1,
      runaway: 1,
      ctrMultCore: finalDay.ctrMultCore,
      formBroken: finalDay.formBroken,
      crMultOf: finalDay.crMultOf,
    }
    return () => post
  }
  return (day) => blendFactorsAt(config, day)
}

/** Дрейф аукциона для проверки потолка входа по фазе (макс. цена входа за прогон). */
function ceilingDrift(config: ScenarioConfig, phase: 'pre' | 'post' | 'blend'): number {
  if (phase === 'pre') return 1
  if (phase === 'post') return blendFactorsAt(config, config.days - 1).drift
  // blend: худший (максимальный) дрейф за прогон
  let maxDrift = 1
  for (let d = 0; d < config.days; d++) maxDrift = Math.max(maxDrift, blendFactorsAt(config, d).drift)
  return maxDrift
}

// ============================================================
// Экономика фразы на уровне (ожидания, шум отброшен)
// ============================================================

/**
 * Ожидаемые заявки и расход фразы на уровне tv за прогон (по собственному
 * запросу фразы — тексту). Клики масштабируются недельной сезонностью, охватом
 * уровня, качеством текстов и (для ядра) атакой конкурента; заявки — истинной
 * CR × режим группы × 0 при сломанной форме; расход — ценой уровня × дрейф ×
 * катастрофа расхода. Шум (±20% / ±10% / биномиальность) отброшен как ноль-среднее.
 */
function levelEconomics(
  config: ScenarioConfig,
  phrase: PhraseSpec,
  tv: number,
  factorsFn: (day: number) => DayFactors
): { leads: number; spend: number } {
  const cpc = config.cpcByTv[tv]
  if (!Number.isFinite(cpc)) return { leads: 0, spend: 0 }
  const ctr = ctrForTv(phrase, tv)
  const cr = clamp01(phrase.trueCr)
  let leads = 0
  let spend = 0
  for (let day = 0; day < config.days; day++) {
    const f = factorsFn(day)
    const weekday = config.weekdayDemand[day % 7] ?? 1
    const quality = adQualityFor(config, phrase.adGroupId, day)
    const impressions = phrase.demandPerDay * weekday * (tv / TV_REACH_DENOM) * f.demandMult
    const clicks = impressions * ctr * quality * (phrase.isCore ? f.ctrMultCore : 1)
    leads += clicks * cr * f.crMultOf(phrase.adGroupId) * (f.formBroken ? 0 : 1)
    spend += clicks * cpc * f.drift * f.runaway
  }
  return { leads, spend }
}

// ============================================================
// Главный вход: вердикты оракула
// ============================================================

export function computeOracleVerdicts(
  config: ScenarioConfig,
  opts?: { phase?: 'pre' | 'post' | 'blend' }
): OracleVerdicts {
  const phase = opts?.phase ?? 'blend'
  const factorsFn = phaseFactors(config, phase)
  const ceilDrift = ceilingDrift(config, phase)

  const phraseById = new Map<number, PhraseSpec>()
  for (const p of config.phrases) phraseById.set(p.keywordId, p)

  // ---------- mustMinus: объёмный структурный мусор ----------
  // Для каждого мусорного запроса аналитически прикидываем расход за прогон по
  // СТАРТОВЫМ ставкам фраз (достигнутый tv → цена уровня). Порог — 100 ₽.
  const mustMinus = new Set<string>()
  for (const q of config.queries) {
    if (!q.isTrash) continue
    let spend = 0
    for (const kid of q.sticksTo) {
      const p = phraseById.get(kid)
      if (!p) continue
      const tvStart = achievedTv(p.startBidMicro, config.cpcByTv)
      if (tvStart <= 0) continue // ставка ниже входа — показов (и расхода) нет
      const price = config.cpcByTv[tvStart]
      if (!Number.isFinite(price)) continue
      const share = clamp01(q.share)
      const ctr = clamp01(q.trueCtr)
      for (let day = 0; day < config.days; day++) {
        const weekday = config.weekdayDemand[day % 7] ?? 1
        const impressions = p.demandPerDay * weekday * (tvStart / TV_REACH_DENOM) * share
        const clicks = impressions * ctr
        spend += clicks * price
      }
    }
    if (spend >= MUSTMINUS_MIN_SPEND_RUB) mustMinus.add(q.query)
  }

  // ---------- mustKeep: живой конвертящий трафик (резать нельзя) ----------
  const mustKeep = new Set<string>()
  for (const p of config.phrases) if (clamp01(p.trueCr) > 0) mustKeep.add(p.text)
  for (const q of config.queries) if (!q.isTrash && clamp01(q.trueCr) > 0) mustKeep.add(q.query)

  // ---------- optimalTv + coды по потолку ----------
  const optimalTv = new Map<number, number | null>()
  const causeCodes: Record<string, ReasonCode> = { ...config.expectations.causeCodes }

  for (const p of config.phrases) {
    // Кандидаты {15,65,75} с ценой входа в пределах потолка 400 ₽.
    const candidates = TV_CANDIDATES.filter(
      (tv) => Number.isFinite(config.cpcByTv[tv]) && config.cpcByTv[tv] * ceilDrift <= BID_CEILING_RUB
    )
    if (candidates.length === 0) {
      // Всё дороже потолка — держаться нечем: не трогать, отметить причину.
      optimalTv.set(p.keywordId, null)
      const key = `keyword:${p.keywordId}`
      if (!(key in causeCodes)) causeCodes[key] = 'AUCTION_ABOVE_CEILING'
      continue
    }
    const econ = candidates.map((tv) => ({ tv, ...levelEconomics(config, p, tv, factorsFn) }))
    const viable = econ.filter((e) => e.leads >= LEAD_POSITIVE_MIN)
    if (viable.length > 0) {
      // Лид-позитивная: уровень с минимальной ценой заявки (расход/заявки),
      // тай-брейк — больший объём заявок.
      viable.sort((a, b) => {
        const cplA = a.spend / a.leads
        const cplB = b.spend / b.leads
        if (cplA !== cplB) return cplA - cplB
        return b.leads - a.leads
      })
      optimalTv.set(p.keywordId, viable[0].tv)
    } else {
      // Лид-негативная: минимальный уровень (обычно 15).
      optimalTv.set(p.keywordId, Math.min(...candidates))
    }
  }

  return {
    mustMinus,
    mustKeep,
    optimalTv,
    causeCodes,
    attributionInferable: new Map(),
    attributionOmniscient: new Map(),
  }
}

// ============================================================
// Эталоны атрибуции: всезнающий и «лучший вывод из наблюдаемого»
// ============================================================

/** Структура internal движка, из которой берётся телефон заявки по индексу клика. */
interface InternalPhones {
  phoneByClick: Map<number, string>
}

/**
 * Эталоны атрибуции по правде мира:
 *  - omniscient — ВСЕ настоящие заявки (leadDay!==null && !leadIsFake):
 *    leadKey(phone, leadDay) → {adGroupId, query};
 *  - inferable — только заявки с живым yclid (потерянный yclid = непознаваемо,
 *    в inferable не кладём).
 * Пустышки (leadIsFake) — нигде.
 */
export function computeAttributionReferences(world: WorldState): {
  omniscient: Map<string, { adGroupId: string; query: string | null }>
  inferable: Map<string, { adGroupId: string; query: string | null }>
} {
  const omniscient = new Map<string, { adGroupId: string; query: string | null }>()
  const inferable = new Map<string, { adGroupId: string; query: string | null }>()
  // internal типизирован как unknown, но структура движка гарантирует phoneByClick.
  const internal = world.internal as InternalPhones
  const phoneByClick = internal?.phoneByClick

  world.truthClicks.forEach((c, index) => {
    if (c.leadDay === null || c.leadIsFake) return // не заявка либо пустышка
    const phone = phoneByClick?.get(index)
    if (phone === undefined) return
    const key = leadKey(phone, c.leadDay)
    const target = { adGroupId: c.adGroupId, query: c.query as string | null }
    omniscient.set(key, target)
    if (c.yclid !== null) inferable.set(key, { adGroupId: c.adGroupId, query: c.query })
  })

  return { omniscient, inferable }
}
