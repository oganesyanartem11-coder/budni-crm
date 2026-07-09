/**
 * Маржинальный подъём конвертеров при недорасходе (М3). Чистые функции.
 *
 * Бюджет стабильно недорасходуется, а маржинальный подъём не существовал: при
 * ненасыщенном бюджете дешевле купить БОЛЬШЕ объёма на конвертерах (выше TV, пока
 * E[CPL] под потолком), чем экономить на клике. Гейт: газ по тренду (медиана окна),
 * тормоз мгновенный (один день у бюджета). DailyBudget не трогается.
 */

import {
  MICRO,
  BID_CEILING_MICRO,
  UNDERSPEND_START_PCT,
  UNDERSPEND_STOP_PCT,
  UNDERSPEND_HOLD_PCT,
} from './config'
import type { RecommendBidResult } from './rules'

/** Микрошум ставки: |дельта| < 5% — не дёргаем (как в rules.recommendBid). */
const BID_NOISE_RATIO = 0.05

/** Премиум-блок (TV ≥ 85) — вето (рубеж ×3-4 по цене); дубль порога из rules. */
const PREMIUM_TV_MIN = 85

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return 0
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

export interface UnderspendGate {
  open: boolean
  medianRub: number | null
  reason: string
}

/**
 * Гейт недорасхода. ОТКРЫТ, только если медиана дневного расхода окна < START% ×
 * DailyBudget И вчерашний расход < STOP% × DailyBudget. Тормоз мгновенный: вчера
 * ≥ STOP% → закрыт независимо от медианы (одного дня у бюджета достаточно).
 * Нет бюджета/данных → закрыт (fail-safe).
 */
export function underspendGateOpen(input: {
  recentDailySpendsRub: number[]
  yesterdaySpendRub: number | null
  dailyBudgetRub: number
  /** Состояние гейта на предыдущем тике (для гистерезиса). Дефолт — закрыт. */
  previouslyOpen?: boolean
}): UnderspendGate {
  if (!(input.dailyBudgetRub > 0)) return { open: false, medianRub: null, reason: 'нет живого бюджета' }
  // Мгновенный тормоз по вчерашнему дню (перекрывает гистерезис).
  if (
    input.yesterdaySpendRub != null &&
    input.yesterdaySpendRub >= UNDERSPEND_STOP_PCT * input.dailyBudgetRub
  ) {
    return { open: false, medianRub: null, reason: 'вчера расход у бюджета — мгновенный тормоз' }
  }
  const spends = input.recentDailySpendsRub.filter((s) => Number.isFinite(s))
  if (spends.length === 0) return { open: false, medianRub: null, reason: 'нет данных расхода окна' }
  const med = median(spends)
  // ГИСТЕРЕЗИС: порог входа (START 0.8) строже порога удержания (HOLD 0.95). Единожды
  // открытый гейт держится, пока медиана < HOLD — иначе подъём ставок сам поднимал бы
  // расход к 0.8 и захлопывал гейт (петля «газ↔тормоз» = осцилляция уровней = «пила»).
  const threshold = input.previouslyOpen ? UNDERSPEND_HOLD_PCT : UNDERSPEND_START_PCT
  const open = med < threshold * input.dailyBudgetRub
  return {
    open,
    medianRub: med,
    reason: open
      ? input.previouslyOpen
        ? 'гейт держится (гистерезис) — газ'
        : 'медиана расхода ниже порога — газ'
      : 'расход у нормы — газ не нужен',
  }
}

/**
 * Маржинальный уровень для промоушен-фразы при открытом гейте: МАКСИМАЛЬНЫЙ
 * НЕ-премиум TV из живой лесенки, где ожидаемая цена заявки E[CPL] =
 * Price(TV) / posteriorCr ≤ cplCapPct × leadValueRub, и Bid ≤ потолка 400 ₽.
 * Премиум (TV ≥ 85) исключён ВСЕГДА. Если ни один уровень не проходит cap —
 * changed=false (остаёмся, базовый вход выберет recommendBid).
 */
export function recommendMarginalBid(input: {
  auctionBids: Array<{ TrafficVolume: number; Bid: number; Price: number }>
  posteriorCr: number
  leadValueRub: number
  cplCapPct: number
  currentBidMicro: number
}): RecommendBidResult {
  const cr = Math.min(1, Math.max(0.001, input.posteriorCr))
  const capRub = input.cplCapPct * input.leadValueRub
  // Кандидаты: НЕ премиум, Bid под потолком, E[CPL] под cap. По возрастанию TV.
  const eligible = input.auctionBids
    .filter((b) => b.TrafficVolume < PREMIUM_TV_MIN && b.Bid <= BID_CEILING_MICRO)
    .filter((b) => b.Price / MICRO / cr <= capRub)
    .sort((a, b) => a.TrafficVolume - b.TrafficVolume)
  const best = eligible[eligible.length - 1]
  if (!best) {
    return { targetBidMicro: input.currentBidMicro, targetTv: null, changed: false, holdReason: 'no_auction' }
  }
  const targetBidMicro = Math.min(best.Bid, BID_CEILING_MICRO)
  // Микрошум: дрейф аукциона < 5% на том же уровне не дёргаем (дисциплина/лимиты API).
  if (input.currentBidMicro > 0) {
    const delta = Math.abs(targetBidMicro - input.currentBidMicro) / input.currentBidMicro
    if (delta < BID_NOISE_RATIO) {
      return { targetBidMicro: input.currentBidMicro, targetTv: null, changed: false, holdReason: 'noise' }
    }
  }
  return { targetBidMicro, targetTv: best.TrafficVolume, changed: targetBidMicro !== input.currentBidMicro }
}
