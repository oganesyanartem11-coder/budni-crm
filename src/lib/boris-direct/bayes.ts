/**
 * Эмпирический Байес для вердиктов ставок (М3). Чистые функции, без IO.
 *
 * Проблема бинарного порога («N кликов, 0 заявок → горелка»): 12–36% ложных
 * приговоров нормально конвертящим фразам (P(0 заявок|20 кликов, CR 10%)=0.122).
 * Решение: prior Beta с матожиданием = CR кампании (вес PRIOR_WEIGHT_CLICKS
 * псевдокликов), posterior фразы = Beta(α+заявки, β+клики−заявки), вердикт по
 * P(CR<порога) с АСИММЕТРИЧНЫМИ порогами (демоушен строже промоушена = гистерезис
 * без временных локов).
 */

import {
  PRIOR_WEIGHT_CLICKS,
  PRIOR_CR_FALLBACK,
  VERDICT_CR_THRESHOLD_FRAC,
  PROMOTE_CONFIDENCE,
  DEMOTE_CONFIDENCE,
} from './config'

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.min(1, Math.max(0, x))
}

/**
 * P(0 заявок | clicks кликов, истинная CR) = (1−CR)^clicks. Точная бинома —
 * мотивация Байеса (мера ложноположительной частоты бинарного порога), сверяется
 * с числами аудита. В самом вердикте НЕ используется (там posterior).
 */
export function binomialZeroLeadsProb(clicks: number, cr: number): number {
  const p = clamp01(cr)
  return Math.pow(1 - p, Math.max(0, clicks))
}

/** Стандартная нормальная CDF Φ(z) (Zelen&Severo, ошибка ~7.5e-8). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}

/**
 * P(X < threshold) для X ~ Beta(alpha, beta) через нормальную аппроксимацию
 * (mean = a/(a+b), var = ab/((a+b)²(a+b+1))). Достаточно точно на наших
 * α,β (десятки). Вырожденные входы (α≤0/β≤0/var≤0) → детерминированный ответ.
 */
export function betaTailBelow(threshold: number, alpha: number, beta: number): number {
  if (!(alpha > 0) || !(beta > 0)) return threshold >= 1 ? 1 : 0
  const sum = alpha + beta
  const mean = alpha / sum
  const variance = (alpha * beta) / (sum * sum * (sum + 1))
  if (!(variance > 0)) return mean < threshold ? 1 : 0
  const z = (threshold - mean) / Math.sqrt(variance)
  return clamp01(normalCdf(z))
}

export type BidVerdict = 'promote' | 'demote' | 'hold'

export interface BidVerdictResult {
  verdict: BidVerdict
  /** P(CR фразы < VERDICT_CR_THRESHOLD) — основа вердикта. */
  pBelow: number
  /** Матожидание posterior (для эмиссии/маржинального E[CPL]). */
  posteriorMean: number
}

/**
 * Вердикт ставки по эмпирическому Байесу:
 * - prior Beta(cr·W, (1−cr)·W), cr = CR кампании (fallback PRIOR_CR_FALLBACK);
 * - posterior = Beta(prior_α + заявки, prior_β + (клики − заявки));
 * - demote (→TV15): P(CR < порога) ≥ DEMOTE_CONFIDENCE (уверенно);
 * - promote (→TV65): P(CR ≥ порога) ≥ PROMOTE_CONFIDENCE (скорее да);
 * - иначе hold (не дёргаем).
 *
 * ТОНКАЯ фраза (0 данных): posterior ≈ prior (CR кампании) → обычно promote —
 * встроенный exploration вместо поглощающего hold. По мере накопления кликов без
 * заявок posterior падает → вердикт стареет к demote; заявка → возвращает к promote.
 */
export function phraseBidVerdict(input: {
  leads: number
  clicks: number
  campaignCr: number
}): BidVerdictResult {
  const cr = Number.isFinite(input.campaignCr) && input.campaignCr > 0
    ? Math.min(0.5, Math.max(0.001, input.campaignCr))
    : PRIOR_CR_FALLBACK
  const w = PRIOR_WEIGHT_CLICKS
  const leads = Math.max(0, input.leads)
  const clicks = Math.max(0, input.clicks)
  const alpha = cr * w + leads
  const beta = (1 - cr) * w + Math.max(0, clicks - leads)
  // Порог вердикта — ОТНОСИТЕЛЬНЫЙ (доля CR кампании): горелка = уверенно ниже
  // половины нормы кампании (а не абсолютных N%, которые врут при низком CR).
  const threshold = VERDICT_CR_THRESHOLD_FRAC * cr
  const pBelow = betaTailBelow(threshold, alpha, beta)
  const posteriorMean = alpha / (alpha + beta)
  let verdict: BidVerdict
  if (pBelow >= DEMOTE_CONFIDENCE) verdict = 'demote'
  else if (1 - pBelow >= PROMOTE_CONFIDENCE) verdict = 'promote'
  else verdict = 'hold'
  return { verdict, pBelow, posteriorMean }
}
