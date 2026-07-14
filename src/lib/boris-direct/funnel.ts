/**
 * Детектор «ВОРОНКА МЕРТВА» (контур №0, спринт 14.07). ЧИСТЫЕ функции — все числа
 * (визиты/цели/клики/конверсии) уже собраны снаружи, здесь только вероятностная
 * оценка серии нулей и текст тревоги.
 *
 * Зачем: аудит 14.07 вскрыл слом воронки сайта 09–13.07 — 72 живых визита по ВСЕМ
 * источникам, 0 целей (P≈0.3% при CR 7.96%). Существующий leads_zero молчал: его
 * порог avg≥2 заявки/день не достигается на низкообъёмном B2B (~0.8/день). Этот
 * детектор судит не по «среднему за 7 дней», а по НЕВЕРОЯТНОСТИ накопленного нуля:
 * P0 = (1 − CR)^Σнаблюдений. Живёт в РОУТЕ (не в мозг-тике) → на полигон не влияет.
 *
 * Две ветки:
 *  - detectFunnelDeath (главная): визиты Метрики (ВСЕ источники) живы, цель = 0 —
 *    ловит слом формы/цели на стороне сайта (страдают все источники сразу);
 *  - detectDirectDrought: клики Директа есть, Директ-конверсий 0 — замена слепого
 *    leads_zero именно для рекламной ветки.
 */

import type { Anomaly } from './anomalies'
import {
  FUNNEL_MIN_VISITS_DAY,
  FUNNEL_DEATH_P0,
  FUNNEL_CR_MIN_VISITS,
  DIRECT_DROUGHT_P0,
  PRIOR_CR_FALLBACK,
} from './config'

/** P(ноль успехов | n наблюдений, истинная конверсия cr) = (1−cr)^n. */
function zeroProb(observations: number, cr: number): number {
  const p = Math.min(1, Math.max(0, cr))
  return Math.pow(1 - p, Math.max(0, observations))
}

export interface HistCrRow {
  visits: number
  goalReaches: number
}

/**
 * Скользящая база конверсии визит→цель по окну. null (детектор молчит), если:
 *  - визитов в окне меньше FUNNEL_CR_MIN_VISITS (база ненадёжна), или
 *  - целей в окне ноль (не было конверсии — не о чем судить, P0 всегда 1).
 */
export function histConversionRate(window: HistCrRow[]): number | null {
  let visits = 0
  let goals = 0
  for (const r of window) {
    visits += Math.max(0, r.visits)
    goals += Math.max(0, r.goalReaches)
  }
  if (visits < FUNNEL_CR_MIN_VISITS) return null
  if (goals <= 0) return null
  return goals / visits
}

/**
 * Длина хвостовой серии наблюдений с нулём успехов: суммирует «объём» подряд идущих
 * с конца дней, где успехов 0; день с успехом ОБРЫВАЕТ серию (счёт с него не идёт).
 * Дни с объёмом ниже minPerDay — ШУМ: в сумму не входят, но серию НЕ обрывают
 * (мало визитов ≠ доказательство жизни воронки).
 */
function trailingZeroVolume(
  days: Array<{ volume: number; successes: number }>,
  minPerDay: number
): number {
  let sum = 0
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]
    if (d.successes > 0) break // успех обрывает серию
    if (d.volume >= minPerDay) sum += d.volume
  }
  return sum
}

export interface FunnelDeathInput {
  /** Дни (все источники) по возрастанию даты: визиты + достижения цели. */
  series: Array<{ day: string; visits: number; goalReaches: number }>
  /** Окно истории для базовой CR визит→цель (обычно последние ~30 дней). */
  histWindow: HistCrRow[]
}

/**
 * ГЛАВНЫЙ детектор. Визиты живые (все источники), цель = 0 подряд → CRITICAL,
 * когда P0 = (1 − CR_hist)^Σвизитов_серии < FUNNEL_DEATH_P0. null иначе / когда
 * база CR ненадёжна. Заземление: только переданные числа.
 */
export function detectFunnelDeath(input: FunnelDeathInput): Anomaly | null {
  const cr = histConversionRate(input.histWindow)
  if (cr == null) return null

  const zeroVisits = trailingZeroVolume(
    input.series.map((d) => ({ volume: d.visits, successes: d.goalReaches })),
    FUNNEL_MIN_VISITS_DAY
  )
  if (zeroVisits <= 0) return null

  const p0 = zeroProb(zeroVisits, cr)
  if (p0 >= FUNNEL_DEATH_P0) return null

  const crPct = (cr * 100).toFixed(1)
  const p0Pct = (p0 * 100).toFixed(2)
  return {
    severity: 'critical',
    kind: 'funnel_death',
    text:
      `[ВОРОНКА] визиты живые (${zeroVisits} за серию, все источники), а целей ноль — ` +
      `при исторической конверсии ${crPct}% вероятность такого нуля ${p0Pct}% (< ${(FUNNEL_DEATH_P0 * 100).toFixed(0)}%). ` +
      `Похоже на слом формы/цели на сайте, а не на трафик — проверь отправку заявки и счётчик Метрики.`,
  }
}

export interface DirectDroughtInput {
  /** Дни Директа по возрастанию: клики + Директ-конверсии (readReportConversions). */
  series: Array<{ day: string; clicks: number; conversions: number }>
  /** CR кампании за окно (Директ). ≤0 / нечисло → дефолтный prior. */
  campaignCr: number
}

/**
 * Ветка Директа: клики есть, Директ-конверсий 0 подряд → WARN, когда
 * P0 = (1 − CR_база)^Σкликов_серии < DIRECT_DROUGHT_P0, где CR_база — CR Директа по
 * ЗДОРОВОМУ префиксу окна пофразной экономики (PHRASE_ECON_WINDOW_DAYS=14 дн, считает
 * detector-cycle), а НЕ 30-дневная. Замена слепого leads_zero
 * для рекламной ветки (порог по невероятности вместо «avg≥2/день»).
 */
export function detectDirectDrought(input: DirectDroughtInput): Anomaly | null {
  const cr =
    Number.isFinite(input.campaignCr) && input.campaignCr > 0
      ? Math.min(0.5, input.campaignCr)
      : PRIOR_CR_FALLBACK

  const zeroClicks = trailingZeroVolume(
    input.series.map((d) => ({ volume: d.clicks, successes: d.conversions })),
    1
  )
  if (zeroClicks <= 0) return null

  const p0 = zeroProb(zeroClicks, cr)
  if (p0 >= DIRECT_DROUGHT_P0) return null

  const crPct = (cr * 100).toFixed(1)
  const p0Pct = (p0 * 100).toFixed(2)
  return {
    severity: 'warn',
    kind: 'direct_drought',
    text:
      `[ДИРЕКТ] ${zeroClicks} кликов подряд без конверсии по цели — при CR кампании ${crPct}% ` +
      `вероятность такого нуля ${p0Pct}% (< ${(DIRECT_DROUGHT_P0 * 100).toFixed(0)}%). ` +
      `Сверь с воронкой сайта и качеством запросов.`,
  }
}
