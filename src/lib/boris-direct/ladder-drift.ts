/**
 * Детектор ДРЕЙФА ЛЕСЕНКИ (контур №0, спринт 14.07). ЧИСТЫЕ функции.
 *
 * Постоянный контур страха владельца «ставки протухли относительно аукциона».
 * Аудит 14.07 показал: снапшоты keywordbids пишутся ЕЖЕДНЕВНО, но день-к-дню
 * никто не сравнивает — «медианная цена входа» в отчёте была статичной константой,
 * а не трендом. Здесь: из снапшота лесенки считаем медиану цены входа (TV≥55) и
 * долю фраз ниже входа; сдвиг за окно (медиана > порога ИЛИ рост below-entry) → WARN.
 *
 * Живёт в РОУТЕ → полигон-нейтрально. Ретро-прогон на снапшотах 30.06–14.07 должен
 * дать дрейф ≈0 (аудит: вход стабилен на 95 ₽) — это его калибровочная проверка.
 */

import type { Anomaly } from './anomalies'
import type { KeywordBidRecord } from './direct-client'
import {
  MICRO,
  TV_LOWER_BLOCK_ENTRY,
  LADDER_DRIFT_MEDIAN_PCT,
  LADDER_DRIFT_BELOW_ENTRY_PP,
} from './config'

export interface LadderSummary {
  /** Медиана СПИСЫВАЕМОЙ цены входа (наименьший TV≥55), ₽; null если фраз нет. */
  entryMedianRub: number | null
  /** Доля фраз, чья ставка НИЖЕ цены входа, %; null если фраз нет. */
  belowEntryPct: number | null
  /** Сколько фраз участвовало (есть лесенка и позиция входа). */
  phrases: number
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Сводка лесенки из снапшота keywordbids: для каждой фразы берём позицию ВХОДА —
 * наименьший TrafficVolume ≥ TV_LOWER_BLOCK_ENTRY. entryMedian — медиана цены
 * входа, belowEntryPct — доля фраз со ставкой ниже неё. Фразы без лесенки/без
 * входа TV≥55 не учитываются (нижняя граница блока для них недостижима — не судим).
 */
export function summarizeLadderEntry(bids: KeywordBidRecord[]): LadderSummary {
  const entryPrices: number[] = []
  let below = 0
  let counted = 0
  for (const b of bids) {
    const ladder = b.Search?.AuctionBids ?? []
    if (ladder.length === 0) continue
    // Позиция входа: наименьший TV ≥ порога входа.
    let entry: { tv: number; bid: number } | null = null
    for (const item of ladder) {
      if (item.TrafficVolume >= TV_LOWER_BLOCK_ENTRY && (entry === null || item.TrafficVolume < entry.tv)) {
        entry = { tv: item.TrafficVolume, bid: item.Bid }
      }
    }
    if (!entry) continue
    counted++
    const entryRub = entry.bid / MICRO
    entryPrices.push(entryRub)
    const ourBidRub = (b.Search?.Bid ?? 0) / MICRO
    if (ourBidRub > 0 && ourBidRub < entryRub) below++
  }
  return {
    entryMedianRub: median(entryPrices),
    belowEntryPct: counted > 0 ? (100 * below) / counted : null,
    phrases: counted,
  }
}

export interface LadderDriftInput {
  today: LadderSummary
  /** Сводка N рабочих дней назад (та же метрика). */
  past: LadderSummary
}

export interface LadderDriftResult {
  /** Относительный сдвиг медианы цены входа (доля): (today−past)/past. */
  medianDeltaPct: number
  /** Рост доли фраз ниже входа, процентных пунктов (today−past). */
  belowEntryDeltaPp: number
  alert: Anomaly | null
}

/**
 * Дрейф лесенки за окно. WARN, если |Δ медианы входа| > LADDER_DRIFT_MEDIAN_PCT
 * ИЛИ доля ниже входа выросла на ≥ LADDER_DRIFT_BELOW_ENTRY_PP п.п. Нет прошлой
 * базы (null) → тишина (нечего сравнивать). Снижение below-entry (улучшение) не
 * тревожит — только рост.
 */
export function detectLadderDrift(input: LadderDriftInput): LadderDriftResult {
  const { today, past } = input
  const canMedian = today.entryMedianRub != null && past.entryMedianRub != null && past.entryMedianRub > 0
  const canBelow = today.belowEntryPct != null && past.belowEntryPct != null

  const medianDeltaPct = canMedian ? (today.entryMedianRub! - past.entryMedianRub!) / past.entryMedianRub! : 0
  const belowEntryDeltaPp = canBelow ? today.belowEntryPct! - past.belowEntryPct! : 0

  const medianTrips = canMedian && Math.abs(medianDeltaPct) > LADDER_DRIFT_MEDIAN_PCT
  const belowTrips = canBelow && belowEntryDeltaPp >= LADDER_DRIFT_BELOW_ENTRY_PP

  let alert: Anomaly | null = null
  if (medianTrips || belowTrips) {
    const dir = medianDeltaPct >= 0 ? 'вырос' : 'упал'
    const parts: string[] = []
    if (canMedian) {
      parts.push(
        `медиана цены входа ${dir} на ${Math.round(Math.abs(medianDeltaPct) * 100)}% ` +
          `(${Math.round(past.entryMedianRub!)}→${Math.round(today.entryMedianRub!)} ₽)`
      )
    }
    if (canBelow) {
      parts.push(
        `доля фраз ниже входа ${Math.round(past.belowEntryPct!)}%→${Math.round(today.belowEntryPct!)}% ` +
          `(${belowEntryDeltaPp >= 0 ? '+' : ''}${Math.round(belowEntryDeltaPp)} п.п.)`
      )
    }
    alert = {
      severity: 'warn',
      kind: 'ladder_drift',
      text:
        `[АУКЦИОН] лесенка сдвинулась за окно: ${parts.join('; ')}. ` +
        `Если аукцион дорожает — наши замороженные уровни покупают меньше объёма; свериться со ставками.`,
    }
  }

  return { medianDeltaPct, belowEntryDeltaPp, alert }
}

// ---------- Тренд позиции (читатель «давно копящегося» AvgTrafficVolume + позиции) ----------

export interface PositionDayRow {
  day: string
  clicks: number
  /** Средняя позиция клика (меньше = выше/лучше). */
  avgClickPosition: number
  /** Выкупаемый объём (больше = лучше). */
  avgTrafficVolume: number
}

export interface PositionTrendDay {
  day: string
  clicks: number
  /** Клико-взвешенная позиция клика за день. */
  weightedPosition: number
  /** Клико-взвешенный TV за день. */
  weightedTv: number
}

export type PositionTrendVerdict = 'improving' | 'worsening' | 'flat' | 'insufficient'

export interface PositionTrend {
  days: PositionTrendDay[]
  trend: PositionTrendVerdict
}

/** Клики-строки нескольких ключей в один день агрегируются по кликам. */
const POSITION_TREND_MIN_DAYS = 2

/** Порог значимого сдвига позиции клика между половинами окна (в «позициях»). */
const POSITION_TREND_DELTA = 1

/**
 * Тренд позиции по «давно копящимся» AvgTrafficVolume/AvgClickPosition из истории
 * по ключу. Аудит 14.07: эти поля собирались, но НИ ОДИН контур на них не смотрел.
 * Строит клико-взвешенную позицию/TV по дням и грубый вердикт: сравниваем среднюю
 * позицию клика первой и второй половин окна (позиция РАСТЁТ = хуже). < 2 дней с
 * кликами → 'insufficient' (не судим). Позиция — чем меньше, тем выше в выдаче.
 */
export function summarizePositionTrend(rows: PositionDayRow[]): PositionTrend {
  const byDay = new Map<string, { clicks: number; posW: number; tvW: number }>()
  for (const r of rows) {
    if (r.clicks <= 0) continue
    const acc = byDay.get(r.day) ?? { clicks: 0, posW: 0, tvW: 0 }
    acc.clicks += r.clicks
    acc.posW += r.avgClickPosition * r.clicks
    acc.tvW += r.avgTrafficVolume * r.clicks
    byDay.set(r.day, acc)
  }
  const days: PositionTrendDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, a]) => ({
      day,
      clicks: a.clicks,
      weightedPosition: a.posW / a.clicks,
      weightedTv: a.tvW / a.clicks,
    }))

  if (days.length < POSITION_TREND_MIN_DAYS) return { days, trend: 'insufficient' }

  const mid = Math.floor(days.length / 2)
  const avg = (list: PositionTrendDay[]) =>
    list.reduce((s, d) => s + d.weightedPosition, 0) / Math.max(1, list.length)
  const early = avg(days.slice(0, mid))
  const late = avg(days.slice(mid))
  const delta = late - early // позиция выросла (стала хуже) → delta > 0

  let trend: PositionTrendVerdict = 'flat'
  if (delta > POSITION_TREND_DELTA) trend = 'worsening'
  else if (delta < -POSITION_TREND_DELTA) trend = 'improving'
  return { days, trend }
}
