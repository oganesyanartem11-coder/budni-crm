/**
 * Level-lock (М3.5): уровень ставки (TrafficVolume) фразы ФИКСИРУЕТСЯ и меняется
 * ТОЛЬКО при смене Байес-вердикта (promote↔demote), не от дневного дрейфа
 * posterior или цен лесенки. Чистые функции; персист — снапшот kind
 * 'phrase_tv_lock' (без миграций, payload = произвольный JSON).
 *
 * Зачем: без фиксации маржинальный подъём привязывался к ШУМНОМУ posterior и
 * образовывал петлю с гейтом недорасхода → осцилляция уровней TV → discipline
 * 96→50 (провал М3). Фиксация уровня по вердикту (а не по posterior) разрывает
 * обе причины: надбавка считается ОДИН раз в момент смены вердикта и дальше
 * заморожена; закрытие гейта уровни НЕ откатывает (они зафиксированы).
 *
 * Внутри уровня цена входа продолжает трекаться recommendBid (noise-gate 5%):
 * держим ФИКСИРОВАННУЮ позицию TV, следуя за дрейфом лесенки, но уровень не
 * прыгает.
 */

import type { BidVerdict } from './bayes'

export interface LockedLevel {
  /** Вердикт, обосновавший уровень (уровень держится, пока вердикт тот же). */
  verdict: BidVerdict
  /** Зафиксированный целевой TrafficVolume. */
  tv: number
}

export type PhraseLevelMap = Map<number, LockedLevel>

export interface ResolveLevelInput {
  /** Прежний зафиксированный уровень фразы (из снапшота) или undefined для новой. */
  prev: LockedLevel | undefined
  /** Текущий вердикт ('promote' | 'demote'); 'hold' сюда не приходит — фраза пропущена выше. */
  verdict: BidVerdict
  /** Базовый уровень по вердикту (promote → TV_LOWER_BLOCK_ENTRY, demote → TV_TAIL). */
  baseTv: number
  /**
   * Маржинальный уровень (ШАГ 4), посчитанный В ЭТОТ момент при открытом гейте.
   * Применяется ТОЛЬКО при (пере)установке уровня на promote и только если выше
   * базового; при заморозке (вердикт не сменился) — игнорируется (не прыгает).
   */
  upliftTv?: number | null
}

export interface ResolveLevelResult {
  /** Целевой TV этого тика. */
  tv: number
  /** Уровень для персиста. */
  lock: LockedLevel
  /** Сменился ли уровень относительно prev (диагностика/эмиссия). */
  changed: boolean
}

/**
 * Разрешает целевой уровень фразы по level-lock:
 *  - вердикт не сменился → уровень ЗАМОРОЖЕН (держим prev.tv, игнорируем baseTv/uplift);
 *  - смена вердикта / новая фраза → (пере)установка: baseTv, плюс (для promote)
 *    маржинальная надбавка upliftTv, если она дана и выше базового — и далее заморожена.
 */
export function resolveLevel(input: ResolveLevelInput): ResolveLevelResult {
  const { prev, verdict, baseTv } = input

  if (prev && prev.verdict === verdict) {
    // Вердикт тот же → уровень заморожен: не пересчитываем от дрейфа/надбавки.
    return { tv: prev.tv, lock: prev, changed: false }
  }

  // Смена вердикта или новая фраза → (пере)установка уровня.
  const uplift = input.upliftTv
  const tv =
    verdict === 'promote' && uplift != null && uplift > baseTv ? uplift : baseTv
  return { tv, lock: { verdict, tv }, changed: prev?.tv !== tv }
}

// ---------- Персист (снапшот 'phrase_tv_lock') ----------

interface PhraseLevelEntry {
  keywordId: number
  verdict: BidVerdict
  tv: number
}

export interface PhraseLevelSnapshot {
  levels: PhraseLevelEntry[]
}

function isVerdict(v: unknown): v is BidVerdict {
  return v === 'promote' || v === 'demote' || v === 'hold'
}

/** Карта уровней → payload снапшота (сериализация). */
export function serializeLevels(map: PhraseLevelMap): PhraseLevelSnapshot {
  return {
    levels: [...map.entries()].map(([keywordId, { verdict, tv }]) => ({ keywordId, verdict, tv })),
  }
}

/**
 * Payload снапшота → карта уровней (десериализация). Пустой/нулевой payload →
 * пустая карта (bootstrap — НЕ падение). Битые записи молча отбрасываются
 * (устойчивость к порче снапшота: лучше потерять одну запись, чем весь тик).
 */
export function deserializeLevels(payload: PhraseLevelSnapshot | null | undefined): PhraseLevelMap {
  const map: PhraseLevelMap = new Map()
  if (!payload || !Array.isArray(payload.levels)) return map
  for (const e of payload.levels) {
    if (e && typeof e.keywordId === 'number' && isVerdict(e.verdict) && typeof e.tv === 'number') {
      map.set(e.keywordId, { verdict: e.verdict, tv: e.tv })
    }
  }
  return map
}
