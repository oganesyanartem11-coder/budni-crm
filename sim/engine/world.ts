/**
 * ДВИЖОК МИРА полигона Бориса-Директа. Реализует контракт WorldEngine
 * (sim/engine/api.ts) поверх типов закона (sim/types.ts).
 *
 * Модель дня (advanceDay): world.day++ → применяем события расписания →
 * аукцион по фразам (уровни TV) → показы → распределение по запросам →
 * минус-лист → клики (биномиально) → стоимость → визиты → заявки с лагом →
 * наблюдаемая проекция DayObservables.
 *
 * Детерминизм: ВСЯ случайность — из seeded mulberry32 (sim/engine/rng.ts).
 * Date.now()/Math.random() запрещены. Один seed + одинаковая последовательность
 * действий = байт-в-байт одинаковый прогон.
 *
 * Правда (truthClicks) — только оракулу/скореру. Наружу — Observables.
 */

import type {
  AdSpec,
  DayObservables,
  ObservedKeywordBid,
  ObservedLead,
  ObservedQueryRow,
  PhraseSpec,
  ScenarioConfig,
  TruthClick,
  WorldState,
} from '../types'
import type { WorldEngine } from './api'
import { binomialApprox, mulberry32, randFloat, randInt, type Rng } from './rng'

// ============================================================
// Константы модели
// ============================================================

/** Бинарная шкала уровней TrafficVolume аукциона Директа. */
const TV_LEVELS = [15, 65, 75, 85, 100] as const

/** Минимальная ставка Директа, микроединицы (0.3 ₽). */
const MIN_BID_MICRO = 300_000
/** Максимальная ставка Директа, микроединицы (25 000 ₽). */
const MAX_BID_MICRO = 25_000_000_000

/** Качество группы, у которой ВСЕ объявления отклонены (деградация CTR). */
const ALL_REJECTED_QUALITY = 0.6

/** Вероятность дойти до формы: целевой визит / мусорный визит. */
const FORM_REACH_TARGET = 0.35
const FORM_REACH_TRASH = 0.05

// ============================================================
// Внутреннее состояние генератора (WorldState.internal)
// ============================================================

/** Показы за день по (day, adGroup, query) — правда мира, копится для отчётов. */
interface ImpressionRec {
  day: number
  query: string
  adGroupId: string
  adGroupName: string
  impressions: number
}

interface InternalState {
  rng: Rng
  /** Накопленный множитель цен аукциона (auction_drift, с дня события). */
  driftMult: number
  /** Форма сломана (form_break … form_fix): заявки в ноль, визиты живут. */
  formBroken: boolean
  /** Множитель CTR ядровых фраз (competitor_brand_attack, с дня события). */
  ctrMultCore: number
  /** Множители CR по группам (regime_change, с дня события). */
  crMultByGroup: Map<string, number>
  /** Счётчик для генерации уникальных yclid. */
  yclidSeq: number
  /** Уже выданные телефоны — гарантия уникальности настоящих заявок. */
  usedPhones: Set<string>
  /** Телефон заявки по индексу клика в truthClicks (в правде телефона нет). */
  phoneByClick: Map<number, string>
  /** Телефон-ДУБЛЬ волны пустышек: индекс события → номер. */
  fakeWavePhone: Map<number, string>
  /** Лог показов по дням/запросам/группам (ключ day\0group\0query). */
  impLog: Map<string, ImpressionRec>
  /** ШАГ 3: инъекция device-среза Метрики (читает фейк metrika-client). */
  deviceStats?: Array<{ device: string; visits: number; goalReaches: number; bounceRate: number }>
  /** ШАГ 3: у кампании нет расписания показов (читает фейк direct-client). */
  noSchedule?: boolean
}

function internalOf(world: WorldState): InternalState {
  return world.internal as InternalState
}

// ============================================================
// Утилиты (чистые, без RNG)
// ============================================================

/** Кламп в [0, 1] с защитой от NaN/Infinity. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.min(1, Math.max(0, x))
}

/** Округление денег до копеек (детерминированное). */
function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0
}

/** Округление долей/метрик до 4 знаков (читаемость отчётов). */
function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0
}

/** Нормализация текста: нижний регистр, ё→е. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е')
}

/** Разбивка запроса/минус-фразы на слова (буквы/цифры, всё прочее — разделитель). */
function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 0)
}

/**
 * Семантика минус-листа (ЕДИНАЯ для мира и оракула): минус-фраза режет запрос,
 * если ВСЕ её слова встречаются среди слов запроса (порядок не важен).
 * Пустые минус-фразы не режут ничего.
 */
export function negativesMatch(negatives: string[], query: string): boolean {
  if (!negatives.length) return false
  const queryWords = new Set(tokenize(query))
  if (!queryWords.size) return false
  for (const neg of negatives) {
    const negWords = tokenize(neg)
    if (negWords.length > 0 && negWords.every((w) => queryWords.has(w))) return true
  }
  return false
}

/** Цена клика уровня tv в рублях с учётом дрейфа аукциона (0, если уровня нет). */
function levelPriceRub(config: ScenarioConfig, driftMult: number, tv: number): number {
  const base = config.cpcByTv[tv]
  return Number.isFinite(base) ? base * driftMult : 0
}

/**
 * Истинный CTR фразы на уровне tv: точное значение из trueCtrByTv, иначе
 * ближайший ЗАДАННЫЙ уровень снизу, иначе минимальный заданный (защита
 * от дырявых конфигов сценария).
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
 * Качество текстов группы на день: среднее textQuality НЕотклонённых объявлений;
 * если объявления есть, но ВСЕ отклонены — деградация 0.6; если объявлений
 * в группе нет вовсе — 1 (нейтрально).
 */
function adQualityFor(ads: AdSpec[], adGroupId: string, day: number): number {
  const groupAds = ads.filter((a) => a.adGroupId === adGroupId)
  if (!groupAds.length) return 1
  const active = groupAds.filter((a) => a.rejectedFromDay === null || a.rejectedFromDay > day)
  if (!active.length) return ALL_REJECTED_QUALITY
  const sum = active.reduce((acc, a) => acc + (Number.isFinite(a.textQuality) ? a.textQuality : 1), 0)
  return sum / active.length
}

/** Сэмпл лага конверсии (день материализации = день клика + лаг). */
function sampleLag(rng: Rng, lagDist: Record<number, number>): number {
  const entries = Object.keys(lagDist)
    .map((k) => [Number(k), lagDist[Number(k)]] as const)
    .filter(([d, p]) => Number.isFinite(d) && d >= 0 && Number.isFinite(p) && p > 0)
    .sort((a, b) => a[0] - b[0])
  if (!entries.length) return 0
  const total = entries.reduce((acc, [, p]) => acc + p, 0)
  // Защита от «сумма ≠ 1» в конфиге: нормируем на фактическую сумму
  let u = rng() * total
  for (const [d, p] of entries) {
    u -= p
    if (u <= 0) return d
  }
  return entries[entries.length - 1][0]
}

/** Детерминированный уникальный телефон заявки: «79» + 9 цифр из RNG. */
function genPhone(st: InternalState): string {
  for (;;) {
    let digits = '79'
    for (let i = 0; i < 9; i++) digits += Math.floor(st.rng() * 10)
    if (!st.usedPhones.has(digits)) {
      st.usedPhones.add(digits)
      return digits
    }
  }
}

/** Ключ лога показов. */
function impKey(day: number, adGroupId: string, query: string): string {
  return `${day} ${adGroupId} ${query}`
}

/** Накопить показы в лог правды. */
function logImpressions(
  st: InternalState,
  day: number,
  query: string,
  adGroupId: string,
  adGroupName: string,
  impressions: number
): void {
  const key = impKey(day, adGroupId, query)
  const rec = st.impLog.get(key)
  if (rec) rec.impressions += impressions
  else st.impLog.set(key, { day, query, adGroupId, adGroupName, impressions })
}

// ============================================================
// Пересборка наблюдаемого поискового отчёта
// ============================================================

/**
 * queryRows пересчитываются из правды НА МОМЕНТ ЗАПРОСА: конверсия видна,
 * только когда её leadDay ≤ текущего дня мира. Так честно моделируется лаг:
 * отчёт за день D, снятый в D+1, ещё не видит заявку с leadDay = D+2 — она
 * «допишется» в строку дня D задним числом, когда мир доживёт до D+2.
 * Атрибуция конверсии — ПО ДНЮ КЛИКА (как Директ атрибутирует цель).
 */
function rebuildQueryRows(world: WorldState): ObservedQueryRow[] {
  const st = internalOf(world)
  const groupNameById = new Map<string, string>()
  for (const p of world.config.phrases) groupNameById.set(p.adGroupId, p.adGroupName)

  const rows = new Map<string, ObservedQueryRow>()
  // 1. Базовые строки из лога показов (показы без кликов тоже видны Борису)
  for (const rec of st.impLog.values()) {
    rows.set(impKey(rec.day, rec.adGroupId, rec.query), {
      day: rec.day,
      query: rec.query,
      adGroupId: rec.adGroupId,
      adGroupName: rec.adGroupName,
      impressions: rec.impressions,
      clicks: 0,
      costRub: 0,
      conversions: 0,
    })
  }
  // 2. Клики/расход/конверсии из правды (пустышки — НЕ клики, мимо отчёта)
  for (const c of world.truthClicks) {
    if (c.leadIsFake) continue
    const key = impKey(c.day, c.adGroupId, c.query)
    let row = rows.get(key)
    if (!row) {
      // Защита: клик без залогированного показа (не должно случаться)
      row = {
        day: c.day,
        query: c.query,
        adGroupId: c.adGroupId,
        adGroupName: groupNameById.get(c.adGroupId) ?? c.adGroupId,
        impressions: 0,
        clicks: 0,
        costRub: 0,
        conversions: 0,
      }
      rows.set(key, row)
    }
    row.clicks += 1
    row.costRub += c.costRub
    if (c.leadDay !== null && c.leadDay <= world.day) row.conversions += 1
  }
  // 3. Стабильный порядок (байт-в-байт при одном seed) + округление денег
  const list = Array.from(rows.values())
  for (const r of list) r.costRub = round2(r.costRub)
  list.sort(
    (a, b) =>
      a.day - b.day ||
      (a.adGroupId < b.adGroupId ? -1 : a.adGroupId > b.adGroupId ? 1 : 0) ||
      (a.query < b.query ? -1 : a.query > b.query ? 1 : 0)
  )
  return list
}

// ============================================================
// Реализация WorldEngine
// ============================================================

function createWorld(config: ScenarioConfig, seed: number): WorldState {
  const internal: InternalState = {
    rng: mulberry32(seed),
    driftMult: 1,
    formBroken: false,
    ctrMultCore: 1,
    crMultByGroup: new Map(),
    yclidSeq: 0,
    usedPhones: new Set(),
    phoneByClick: new Map(),
    fakeWavePhone: new Map(),
    impLog: new Map(),
    // ШАГ 3: разведочные сигналы сценария (undefined у существующих → инертны).
    deviceStats: config.diagnostics?.deviceStats,
    noSchedule: config.diagnostics?.noSchedule,
  }
  const bidsMicro = new Map<number, number>()
  for (const p of config.phrases) bidsMicro.set(p.keywordId, Math.round(p.startBidMicro))
  return {
    config,
    seed,
    // День -1: мир создан, но ни один день не сгенерирован.
    // Первый advanceDay инкрементирует до 0 (понедельник) и генерит его.
    day: -1,
    bidsMicro,
    negatives: [],
    campaignSuspended: false,
    keywordsSuspended: new Set(),
    addMetricaTag: 'YES',
    truthClicks: [],
    internal,
  }
}

function advanceDay(world: WorldState): DayObservables {
  const st = internalOf(world)
  const cfg = world.config
  const rng = st.rng

  // ---------- 0. Новый день ----------
  world.day += 1
  const day = world.day

  // ---------- 1. События-переключатели этого дня (в порядке расписания) ----------
  for (const ev of cfg.events) {
    if (ev.day !== day) continue
    switch (ev.kind) {
      case 'form_break':
        st.formBroken = true
        break
      case 'form_fix':
        st.formBroken = false
        break
      case 'regime_change':
        // Группа сменила экономику: CR умножается с этого дня
        st.crMultByGroup.set(ev.adGroupId, ev.newCrMultiplier)
        break
      case 'auction_drift':
        // Аукцион дорожает/дешевеет С этого дня (накопительно)
        st.driftMult *= ev.priceMultiplier
        break
      case 'metrica_tag_off':
        // Разметка слетела: yclid новых заявок теряется, пока не починят setMetricaTag('YES')
        world.addMetricaTag = 'NO'
        break
      case 'competitor_brand_attack':
        // Конкурент в выдаче: CTR ядровых фраз падает с этого дня
        st.ctrMultCore = ev.ctrMultiplierCore
        break
      default:
        // Оконные события (demand_dip, bot_wave, fake_leads_wave,
        // intraday_budget_runaway) обрабатываются ниже по активности окна
        break
    }
  }

  // ---------- 2. Оконные множители дня ----------
  let demandMult = 1 // сезонный провал спроса
  let runawayMult = 1 // катастрофа расхода внутри дня
  for (const ev of cfg.events) {
    if (ev.kind === 'demand_dip' && day >= ev.day && day < ev.day + ev.days) demandMult *= ev.multiplier
    if (ev.kind === 'intraday_budget_runaway' && ev.day === day) runawayMult *= ev.multiplier
  }
  // День 0 = понедельник: индекс дня недели — просто day % 7
  const weekdayMult = cfg.weekdayDemand[day % 7] ?? 1

  // ---------- 3. Аукцион и генерация трафика по фразам ----------
  const keywordBids: ObservedKeywordBid[] = []
  const tvByKeyword = new Map<number, number>()
  const phraseById = new Map<number, PhraseSpec>()
  let impressionsToday = 0

  for (const phrase of cfg.phrases) {
    phraseById.set(phrase.keywordId, phrase)
    const bid = world.bidsMicro.get(phrase.keywordId) ?? Math.round(phrase.startBidMicro)

    // Аукцион фразы на сегодня: уровни бинарной шкалы с ценами (дрейф учтён).
    // Bid уровня = его цена («минимальная ставка, дающая уровень»).
    const auction = TV_LEVELS.filter((l) => Number.isFinite(cfg.cpcByTv[l])).map((l) => {
      const priceMicro = Math.max(0, Math.round(cfg.cpcByTv[l] * 1_000_000 * st.driftMult))
      return { tv: l as number, bidMicro: priceMicro, priceMicro }
    })
    keywordBids.push({ keywordId: phrase.keywordId, adGroupId: phrase.adGroupId, bidMicro: bid, auction })

    // Достигнутый уровень: максимальный, чья цена ≤ ставки. Дороже всех — 0 (нет показов).
    let tv = 0
    for (const lvl of auction) if (lvl.priceMicro <= bid) tv = Math.max(tv, lvl.tv)
    tvByKeyword.set(phrase.keywordId, tv)

    // Остановки и недостижимый аукцион: показов нет
    if (world.campaignSuspended || world.keywordsSuspended.has(phrase.keywordId) || tv === 0) continue

    // Показы фразы: спрос × сезонность недели × охват уровня × шум ±20% × провал спроса
    const noise = randFloat(rng, 0.8, 1.2)
    const impressions = Math.max(0, Math.round(phrase.demandPerDay * weekdayMult * (tv / 75) * demandMult * noise))
    if (impressions <= 0) continue

    // Распределение показов по запросам: прилипшие отъедают свои доли,
    // «свой» запрос фразы (текст фразы) забирает остаток.
    const sticky = cfg.queries.filter((q) => q.sticksTo.includes(phrase.keywordId))
    let stickyImp = 0
    const stickyRows = sticky.map((q) => {
      const imp = Math.max(0, Math.round(impressions * clamp01(q.share)))
      stickyImp += imp
      return { query: q.query, isTrash: q.isTrash, ctr: clamp01(q.trueCtr), cr: clamp01(q.trueCr), imp }
    })
    const ownImp = Math.max(0, impressions - stickyImp)
    const rows = [
      // Свой запрос ПЕРВЫМ: стабильный порядок RNG-вызовов
      { query: phrase.text, isTrash: false, ctr: ctrForTv(phrase, tv), cr: clamp01(phrase.trueCr), imp: ownImp },
      ...stickyRows,
    ]

    const quality = adQualityFor(cfg.ads, phrase.adGroupId, day)
    const cpcRub = levelPriceRub(cfg, st.driftMult, tv)
    const groupCrMult = st.crMultByGroup.get(phrase.adGroupId) ?? 1

    for (const row of rows) {
      if (row.imp <= 0) continue
      // Минус-лист кампании: отсечённый запрос НЕ показывается,
      // его показы ПРОПАДАЮТ (не перетекают в другие запросы)
      if (negativesMatch(world.negatives, row.query)) continue

      logImpressions(st, day, row.query, phrase.adGroupId, phrase.adGroupName, row.imp)
      impressionsToday += row.imp

      // Клики: биномиально от показов; CTR × качество текстов × атака конкурента (по ядру)
      const pClick = clamp01(row.ctr * quality * (phrase.isCore ? st.ctrMultCore : 1))
      const clicks = binomialApprox(rng, row.imp, pClick)

      for (let i = 0; i < clicks; i++) {
        // Стоимость клика: цена достигнутого уровня × шум ±10% × множитель катастрофы расхода
        const costRub = round2(cpcRub * randFloat(rng, 0.9, 1.1) * runawayMult)

        // yclid: при слетевшей разметке теряется ВСЕГДА, иначе — с вероятностью yclidLossRate
        let yclid: string | null
        if (world.addMetricaTag === 'NO') {
          yclid = null
        } else {
          const lost = rng() < clamp01(cfg.yclidLossRate)
          yclid = lost ? null : `y${world.seed}-${++st.yclidSeq}`
        }

        // Визит Метрики: качество зависит от целевой/мусорной природы запроса.
        // form_break НЕ трогает reachedForm (посетитель дошёл) — ломаются только заявки.
        let visit: TruthClick['visit']
        if (row.isTrash) {
          const depth = randInt(rng, 1, 2)
          visit = {
            depthPages: depth,
            durationSec: randInt(rng, 5, 30),
            reachedForm: rng() < FORM_REACH_TRASH,
            bounced: depth === 1,
          }
        } else {
          const depth = randInt(rng, 2, 6)
          visit = {
            depthPages: depth,
            durationSec: randInt(rng, 40, 300),
            reachedForm: rng() < FORM_REACH_TARGET,
            bounced: depth === 1,
          }
        }

        // Заявка: истинная CR запроса × режим группы (regime_change) × 0 при сломанной форме.
        // RNG дёргаем ВСЕГДА (стабильность потока при p=0).
        const pLead = clamp01(row.cr * groupCrMult) * (st.formBroken ? 0 : 1)
        const converts = rng() < pLead
        const leadDay = converts ? day + sampleLag(rng, cfg.conversionLagDays) : null

        // Телефон заявки — детерминированный уникальный, генерится в момент клика
        if (leadDay !== null) st.phoneByClick.set(world.truthClicks.length, genPhone(st))

        world.truthClicks.push({
          day,
          keywordId: phrase.keywordId,
          adGroupId: phrase.adGroupId,
          query: row.query,
          isTrashQuery: row.isTrash,
          yclid,
          costRub,
          visit,
          leadDay,
          leadIsFake: false,
        })
      }
    }
  }

  // ---------- 4. bot_wave: клики без визитов (расход есть, Метрика пуста) ----------
  for (const ev of cfg.events) {
    if (ev.kind !== 'bot_wave') continue
    if (!(day >= ev.day && day < ev.day + ev.days)) continue
    for (const kid of ev.keywordIds) {
      const phrase = phraseById.get(kid)
      if (!phrase) continue
      const tv = tvByKeyword.get(kid) ?? 0
      // Кампания/фраза не показывается — ботам нечего кликать
      if (world.campaignSuspended || world.keywordsSuspended.has(kid) || tv === 0) continue
      const cpcRub = levelPriceRub(cfg, st.driftMult, tv)
      for (let i = 0; i < ev.clicksPerDay; i++) {
        const costRub = round2(cpcRub * randFloat(rng, 0.9, 1.1) * runawayMult)
        // Бот делает показ+клик по запросу = тексту фразы (CTR отчёта не ломаем)
        logImpressions(st, day, phrase.text, phrase.adGroupId, phrase.adGroupName, 1)
        impressionsToday += 1
        world.truthClicks.push({
          day,
          keywordId: kid,
          adGroupId: phrase.adGroupId,
          query: phrase.text,
          isTrashQuery: false,
          yclid: null,
          costRub,
          visit: null, // бот: визита в Метрике НЕТ
          leadDay: null,
          leadIsFake: false,
        })
      }
    }
  }

  // ---------- 5. fake_leads_wave: заявки-пустышки (спам, не клики Директа) ----------
  cfg.events.forEach((ev, evIndex) => {
    if (ev.kind !== 'fake_leads_wave') return
    if (!(day >= ev.day && day < ev.day + ev.days)) return
    // Телефон-ДУБЛЬ: один и тот же номер на всю волну
    let phone = st.fakeWavePhone.get(evIndex)
    if (phone === undefined) {
      phone = genPhone(st)
      st.fakeWavePhone.set(evIndex, phone)
    }
    for (let i = 0; i < ev.leadsPerDay; i++) {
      st.phoneByClick.set(world.truthClicks.length, phone)
      world.truthClicks.push({
        day,
        keywordId: 0, // синтетика: не привязана к фразе
        adGroupId: '',
        query: '',
        isTrashQuery: false,
        yclid: null, // без yclid-цепочки
        costRub: 0, // расход Директа не растёт
        visit: null,
        leadDay: day, // материализуется сразу
        leadIsFake: true,
      })
    }
  })

  // ---------- 6. Наблюдаемая проекция дня ----------
  const queryRows = rebuildQueryRows(world)

  // Метрика за день: по визитам сегодняшних кликов (пустышки/боты без визитов)
  const todayVisits: TruthClick[] = []
  let spentTodayRub = 0
  for (const c of world.truthClicks) {
    if (c.day !== day) continue
    spentTodayRub += c.costRub
    if (!c.leadIsFake && c.visit !== null) todayVisits.push(c)
  }
  const visits = todayVisits.length
  let bouncedCount = 0
  let depthSum = 0
  let formCount = 0
  for (const c of todayVisits) {
    if (c.visit!.bounced) bouncedCount += 1
    depthSum += c.visit!.depthPages
    if (c.visit!.reachedForm) formCount += 1
  }

  // Достижения цели — по дню МАТЕРИАЛИЗАЦИИ заявки (leadDay), настоящие и с визитом
  const goalClicks = world.truthClicks.filter((c) => !c.leadIsFake && c.visit !== null && c.leadDay === day)

  // Разрез по utm_term: только визиты с живым yclid (потерян yclid → потерян и utm)
  const utmMap = new Map<string, { utmTerm: string; visits: number; goalReaches: number }>()
  for (const c of todayVisits) {
    if (c.yclid === null) continue
    const rec = utmMap.get(c.query) ?? { utmTerm: c.query, visits: 0, goalReaches: 0 }
    rec.visits += 1
    utmMap.set(c.query, rec)
  }
  for (const c of goalClicks) {
    if (c.yclid === null) continue
    const rec = utmMap.get(c.query) ?? { utmTerm: c.query, visits: 0, goalReaches: 0 }
    rec.goalReaches += 1
    utmMap.set(c.query, rec)
  }
  const metrikaByUtm = Array.from(utmMap.values()).sort((a, b) =>
    a.utmTerm < b.utmTerm ? -1 : a.utmTerm > b.utmTerm ? 1 : 0
  )

  // Новые заявки дня (leadDay = day), ВКЛЮЧАЯ пустышки
  const newLeads: ObservedLead[] = []
  world.truthClicks.forEach((c, index) => {
    if (c.leadDay !== day) return
    newLeads.push({
      day,
      phoneDigits: st.phoneByClick.get(index) ?? '',
      yclid: c.yclid,
      // Потерян yclid (или пустышка) — потеряна вся utm-разметка
      utmCampaign: c.yclid !== null ? cfg.id : null,
      utmTerm: c.yclid !== null ? c.query : null,
    })
  })

  const rejectedAdsCount = cfg.ads.filter((a) => a.rejectedFromDay !== null && a.rejectedFromDay <= day).length

  return {
    day,
    queryRows,
    keywordBids,
    metrika: {
      day,
      visits,
      goalReaches: goalClicks.length,
      bounceRate: visits > 0 ? round4(bouncedCount / visits) : 0,
      avgDepth: visits > 0 ? round4(depthSum / visits) : 0,
      formReachRate: visits > 0 ? round4(formCount / visits) : 0,
    },
    metrikaByUtm,
    newLeads,
    spentTodayRub: round2(spentTodayRub),
    impressionsToday,
    rejectedAdsCount,
    addMetricaTag: world.addMetricaTag,
  }
}

// ---------- Мутаторы: простые записи, эффект со следующего advanceDay ----------

function setBid(world: WorldState, keywordId: number, bidMicro: number): void {
  if (!Number.isFinite(bidMicro)) return // защита от NaN/Infinity: игнор
  // Кламп к границам аукциона Директа (потолок 400 ₽ — забота Бориса, не движка)
  const clamped = Math.min(MAX_BID_MICRO, Math.max(MIN_BID_MICRO, Math.round(bidMicro)))
  world.bidsMicro.set(keywordId, clamped)
}

function setNegatives(world: WorldState, negatives: string[]): void {
  // Полная замена списка (кампейн-левел), копия — защита от внешних мутаций
  world.negatives = negatives.filter((n) => typeof n === 'string').map((n) => n)
}

function suspendCampaign(world: WorldState): void {
  world.campaignSuspended = true
}

function suspendKeywords(world: WorldState, keywordIds: number[]): void {
  for (const id of keywordIds) world.keywordsSuspended.add(id)
}

function setMetricaTag(world: WorldState, value: 'YES' | 'NO'): void {
  world.addMetricaTag = value
}

// ---------- Итоги правды (экономика скорера) ----------

function getTotals(world: WorldState): { spendRub: number; trueLeads: number; observedLeads: number } {
  let spendRub = 0
  let trueLeads = 0
  let observedLeads = 0
  for (const c of world.truthClicks) {
    spendRub += c.costRub
    if (c.leadDay !== null && c.leadDay <= world.day) {
      observedLeads += 1 // владелец видит все материализовавшиеся заявки, вкл. пустышки
      if (!c.leadIsFake) trueLeads += 1 // правда мира: настоящий спрос
    }
  }
  return { spendRub: round2(spendRub), trueLeads, observedLeads }
}

// ============================================================
// Экспорт движка
// ============================================================

export const worldEngine: WorldEngine = {
  createWorld,
  advanceDay,
  setBid,
  setNegatives,
  suspendCampaign,
  suspendKeywords,
  setMetricaTag,
  getTotals,
  negativesMatch,
}
