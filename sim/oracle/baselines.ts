/**
 * БОТЫ-ЭТАЛОНЫ полигона Бориса-Директа (baselines).
 *
 * Боты действуют напрямую через движок (без мозга Бориса): раннер зовёт
 * bot.onDayEnd(...) после каждого дня. Каждое действие бота — это (а) мутатор
 * движка (setBid/setNegatives) и (б) запись в captured (CapturedAction), чтобы
 * скорер видел цепочку решений так же, как для Бориса.
 *
 * Экономические якоря скорера:
 *  - lazy   — нижний пол (ничего не делает, живёт на стартовых ставках);
 *  - oracle — верхний потолок (ставит оптимум оракула и минусует объёмный мусор).
 * random/greedy — характерные «плохие привычки» для контраста.
 *
 * Детерминизм: у random — единственный источник случайности (переданный rng);
 * остальные боты чисто-детерминированы от наблюдаемого.
 */

import type { WorldEngine } from '../engine/api'
import type {
  CapturedAction,
  DayObservables,
  ObservedKeywordBid,
  OracleVerdicts,
  PolicyName,
  WorldState,
} from '../types'

/** Единый контракт бота-политики (раннер держит ссылку на onDayEnd). */
export interface BotPolicy {
  name: PolicyName
  onDayEnd(world: WorldState, engine: WorldEngine, dayObs: DayObservables, captured: CapturedAction[]): void
}

// ============================================================
// Именованные константы
// ============================================================

/** Потолок ставки бота, микроединицы (400 ₽ — как у Бориса). */
const BID_CEILING_MICRO = 400_000_000
/** Уровни, которыми оперируют боты. */
const RANDOM_LEVELS = [15, 65, 75] as const
/** Жадный бот тянет конвертящие группы на этот уровень. */
const GREEDY_TARGET_TV = 75
/** random: вероятность тронуть ставку за день. */
const RANDOM_BID_PROB = 0.3
/** random: вероятность добавить минус-запрос за день. */
const RANDOM_NEG_PROB = 0.2

// ============================================================
// Общие помощники
// ============================================================

/** Цена уровня tv из аукциона дня (микро), либо null если уровня нет. */
function levelPriceMicro(kb: ObservedKeywordBid, tv: number): number | null {
  const lvl = kb.auction.find((a) => a.tv === tv)
  return lvl ? lvl.priceMicro : null
}

/**
 * Ставка под уровень 75 (если его цена в пределах потолка 400 ₽), иначе
 * максимальный доступный из {65, 15} с ценой ≤ потолка.
 */
function greedyBidMicro(kb: ObservedKeywordBid): number {
  for (const tv of [GREEDY_TARGET_TV, 65, 15]) {
    const price = levelPriceMicro(kb, tv)
    if (price !== null && price <= BID_CEILING_MICRO) return price
  }
  // Край: ничего не влезло под потолок — минимально доступное, но не выше потолка.
  const first = kb.auction[0]?.priceMicro
  return Math.min(BID_CEILING_MICRO, first ?? BID_CEILING_MICRO)
}

// ============================================================
// lazy — ничего не делает
// ============================================================

export function makeLazyBot(): BotPolicy {
  return {
    name: 'lazy',
    onDayEnd() {
      // Пол экономики: живём на стартовых ставках, ни одного write.
    },
  }
}

// ============================================================
// random — шумит детерминированно от единственного rng
// ============================================================

export function makeRandomBot(rng: () => number): BotPolicy {
  // Собственный (растущий) минус-лист бота — «полный новый список» в setNegatives.
  const negatives: string[] = []

  return {
    name: 'random',
    onDayEnd(world, engine, dayObs, captured) {
      // 1) С вероятностью ~0.3 — случайная ставка случайной фразе на случайный уровень.
      if (rng() < RANDOM_BID_PROB && dayObs.keywordBids.length > 0) {
        const kb = dayObs.keywordBids[Math.floor(rng() * dayObs.keywordBids.length)]
        const tv = RANDOM_LEVELS[Math.floor(rng() * RANDOM_LEVELS.length)]
        const price = levelPriceMicro(kb, tv)
        if (price !== null) {
          const toMicro = Math.min(price, BID_CEILING_MICRO)
          engine.setBid(world, kb.keywordId, toMicro)
          captured.push({
            day: world.day,
            type: 'bid_set',
            payload: [{ keywordId: kb.keywordId, toMicro }],
            by: 'random',
          })
        }
      }

      // 2) С вероятностью ~0.2 — добавить случайный наблюдаемый запрос дня в минус-лист.
      if (rng() < RANDOM_NEG_PROB && dayObs.queryRows.length > 0) {
        const q = dayObs.queryRows[Math.floor(rng() * dayObs.queryRows.length)].query
        if (!negatives.includes(q)) {
          negatives.push(q)
          engine.setNegatives(world, [...negatives])
          captured.push({ day: world.day, type: 'negatives_set', payload: [...negatives], by: 'random' })
        }
      }
    },
  }
}

// ============================================================
// greedy — переоценивает вчерашний день (жадность и паника)
// ============================================================

export function makeGreedyBot(): BotPolicy {
  let prev: DayObservables | null = null
  const negatives: string[] = []

  return {
    name: 'greedy',
    onDayEnd(world, engine, dayObs, captured) {
      const day = world.day
      if (prev && day >= 2) {
        // 1) Минус: ВСЕ вчерашние запросы с кликами и без конверсий (жадность —
        //    режет и живой трафик, чьи конверсии просто ещё не дозрели по лагу).
        let negChanged = false
        for (const row of prev.queryRows) {
          if (row.day !== prev.day) continue
          if (row.clicks >= 1 && row.conversions === 0 && !negatives.includes(row.query)) {
            negatives.push(row.query)
            negChanged = true
          }
        }
        if (negChanged) {
          engine.setNegatives(world, [...negatives])
          captured.push({ day, type: 'negatives_set', payload: [...negatives], by: 'greedy' })
        }

        // 2) Ставки: группы, где вчера была хоть одна конверсия, — тянем на 75.
        const convGroups = new Set<string>()
        for (const row of prev.queryRows) {
          if (row.day === prev.day && row.conversions > 0) convGroups.add(row.adGroupId)
        }
        const payload: Array<{ keywordId: number; toMicro: number }> = []
        for (const kb of dayObs.keywordBids) {
          if (!convGroups.has(kb.adGroupId)) continue
          const toMicro = greedyBidMicro(kb)
          engine.setBid(world, kb.keywordId, toMicro)
          payload.push({ keywordId: kb.keywordId, toMicro })
        }
        if (payload.length > 0) captured.push({ day, type: 'bid_set', payload, by: 'greedy' })
      }
      prev = dayObs
    },
  }
}

// ============================================================
// oracle — ставит оптимум оракула, минусует объёмный мусор, адаптируется
// ============================================================

export function makeOracleBot(
  verdictsPre: OracleVerdicts,
  verdictsPost: OracleVerdicts | null,
  switchDay: number | null
): BotPolicy {
  /** Выставить ставки под optimalTv вердиктов (уровень null → не трогать). */
  function applyBids(
    world: WorldState,
    engine: WorldEngine,
    dayObs: DayObservables,
    captured: CapturedAction[],
    verdicts: OracleVerdicts,
    day: number
  ): void {
    const payload: Array<{ keywordId: number; toMicro: number }> = []
    for (const kb of dayObs.keywordBids) {
      const tv = verdicts.optimalTv.get(kb.keywordId)
      if (tv === undefined || tv === null) continue
      // Ставка РОВНО как priceMicro уровня из аукциона дня — чтобы достигнутый
      // tv совпал (в priceMicro уже учтён дрейф).
      const price = levelPriceMicro(kb, tv)
      if (price === null) continue
      const toMicro = Math.min(price, BID_CEILING_MICRO)
      engine.setBid(world, kb.keywordId, toMicro)
      payload.push({ keywordId: kb.keywordId, toMicro })
    }
    if (payload.length > 0) captured.push({ day, type: 'bid_set', payload, by: 'oracle' })
  }

  return {
    name: 'oracle',
    onDayEnd(world, engine, dayObs, captured) {
      const day = world.day
      // День 1: стартовая калибровка по pre-вердиктам + минус объёмного мусора.
      if (day === 1) {
        applyBids(world, engine, dayObs, captured, verdictsPre, day)
        if (verdictsPre.mustMinus.size > 0) {
          const list = [...verdictsPre.mustMinus]
          engine.setNegatives(world, list)
          captured.push({ day, type: 'negatives_set', payload: list, by: 'oracle' })
        }
      }
      // Со дня смены режима — перевыставить ставки по post-вердиктам.
      if (switchDay !== null && verdictsPost && day === switchDay) {
        applyBids(world, engine, dayObs, captured, verdictsPost, day)
      }
    },
  }
}
