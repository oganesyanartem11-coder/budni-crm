/**
 * Ramp-in (М3.5): ввод портфеля правок ставок ПОРЦИЯМИ под circuit breaker.
 *
 * После деплоя, меняющего вердикты, мозг хочет перестроить полпортфеля разом
 * (10.07: 93 правки). CB такую массу не пропускает целиком (порог 40 правок/тик
 * И рост ставочной массы >50%/тик) → без ramp-in каждое утро тот же залп → тот же
 * стоп → алерт. Ramp-in применяет МАКСИМАЛЬНОЕ подмножество, которое CB
 * пропускает, а остаток НЕ хранит очередью — на следующем тике план
 * пересчитывается заново от живых данных (и «догоняет» за несколько тиков).
 *
 * CB НЕ ОСЛАБЛЯЕТСЯ: подмножество строится через тот же checkCircuitBreaker
 * (единый источник правды порогов) — ramp-in живёт ПОД предохранителем, а не
 * рядом с ним.
 *
 * Приоритет включения (ТЗ), когда план НЕ влезает в CB целиком:
 *  1) реестровые/доказанные конвертеры;
 *  2) наибольший ожидаемый эффект (|Δ| × уверенность вердикта);
 *  3) хвост-exploration последним.
 * Демоуты (снижение массы) admit-ятся первыми: они безопасны для CB (масса
 * падает) И освобождают запас массы, БЕЗ которого ни один крупный подъём
 * конвертера в одиночку не прошёл бы mass-cap (одиночный подъём 156→336 = +115%
 * сам по себе бьёт порог 50%). Так «конвертеры вперёд» соблюдается СРЕДИ
 * подъёмов, а демоуты лишь готовят им место.
 *
 * ВАЖНО (честно о жадности): если ВЕСЬ план проходит CB — применяем целиком
 * (быстрый путь), приоритет тогда неважен (влезло всё). Отсев начинается ТОЛЬКО
 * когда план не влезает; там жадность идёт по приоритету, но конвертер, чей
 * подъём CB не может вместить даже с разбавлением демоутами, ОТКЛАДЫВАЕТСЯ на
 * следующий тик (реальный запрет CB, не наша воля), а освободившийся бюджет массы
 * достаётся менее приоритетным правкам, которые влезают. Это не инверсия ради
 * инверсии — это «применяем максимум того, что CB пропускает, конвертеров в
 * первую очередь».
 */

import { checkCircuitBreaker } from './rules'
import { MICRO, CB_ALERT_TOP_N } from './config'
import type { BidVerdict } from './bayes'
import type { BidChange } from './write-gate'

export interface EnrichedChange extends BidChange {
  /** Вердикт правки ('promote' — подъём/вход, 'demote' — минимум). */
  verdict: BidVerdict
  /** Уверенность вердикта [0..1]: promote → P(CR≥порога), demote → P(CR<порога). */
  confidence: number
  /** Реестровый/доказанный конвертер — высший приоритет. */
  protectedConv: boolean
  /** promote тонкой беззаявочной фразы — exploration-хвост, последний. */
  isExploration: boolean
}

export interface RampInResult {
  /** Подмножество в рамках CB — чистые BidChange для applyBidChanges. */
  apply: BidChange[]
  /** То же подмножество с контекстом (для эмиссии/отчёта). */
  applyEnriched: EnrichedChange[]
  /** Остаток — НЕ очередь: пересчитывается на следующем тике заново. */
  deferred: EnrichedChange[]
}

function isDemote(c: EnrichedChange): boolean {
  return c.toMicro < c.fromMicro
}

/** Ранг приоритета среди ПОДЪЁМОВ (меньше — раньше): конвертер → данные → exploration. */
function raiseTier(c: EnrichedChange): number {
  if (c.protectedConv) return 0
  if (c.isExploration) return 2
  return 1
}

function score(c: EnrichedChange): number {
  return c.confidence * Math.abs(c.toMicro - c.fromMicro)
}

/** Чистый BidChange (без обогащения) для гейта/CB. */
function bare(c: EnrichedChange): BidChange {
  return { keywordId: c.keywordId, fromMicro: c.fromMicro, toMicro: c.toMicro }
}

/**
 * Отбирает подмножество правок, которое проходит circuit breaker, в порядке
 * приоритета. Жадно: идём по приоритету и добавляем правку, только если
 * checkCircuitBreaker расширенного подмножества всё ещё ok; иначе — в defer и
 * ПРОДОЛЖАЕМ (меньшая правка позже может влезть). Итоговое подмножество по
 * построению проходит CB (каждый префикс проверен).
 */
export function selectRampInSubset(plan: EnrichedChange[]): RampInResult {
  if (plan.length === 0) return { apply: [], applyEnriched: [], deferred: [] }

  // БЫСТРЫЙ ПУТЬ: весь план проходит CB → применяем ЦЕЛИКОМ (как старый код —
  // all-or-nothing при проходящем CB). Без него prefix-жадность ниже могла бы
  // отложить даже приоритетную правку из-за НЕМОНОТОННОСТИ mass-ratio на тонком
  // префиксе (крупный относительный подъём конвертера, проверенный до накопления
  // разбавляющей массы) → инверсия приоритета И расхождение с базовым поведением на
  // НЕсрабатывающем тике. Жадность нужна ТОЛЬКО когда план реально не влезает в CB.
  if (checkCircuitBreaker(plan.map(bare)).ok) {
    return { apply: plan.map(bare), applyEnriched: [...plan], deferred: [] }
  }

  // Порядок жадности: сперва демоуты (безопасны + дают запас массы), затем
  // подъёмы по приоритету (конвертер → данные → exploration), внутри — по |Δ|×уверенность.
  const ordered = [...plan].sort((a, b) => {
    const aD = isDemote(a) ? 0 : 1
    const bD = isDemote(b) ? 0 : 1
    if (aD !== bD) return aD - bD
    if (aD === 1) {
      const t = raiseTier(a) - raiseTier(b)
      if (t !== 0) return t
    }
    return score(b) - score(a)
  })

  const applyEnriched: EnrichedChange[] = []
  const apply: BidChange[] = []
  const deferred: EnrichedChange[] = []

  for (const c of ordered) {
    if (checkCircuitBreaker([...apply, bare(c)]).ok) {
      apply.push(bare(c))
      applyEnriched.push(c)
    } else {
      deferred.push(c)
    }
  }

  return { apply, applyEnriched, deferred }
}

// ---------- Содержательный CB-алерт (немой стоп запрещён как класс) ----------

/** Одна остановленная правка ставки для содержательного CB-алерта. */
export interface CbStoppedChange {
  keyText: string
  fromMicro: number
  toMicro: number
  verdict: BidVerdict
}

/**
 * Содержательная сводка остановленного предохранителем плана правок ставок (М3.5):
 * правок вверх/вниз, диапазон Δ, топ-N по |Δ| (фраза → текущая → целевая ставка →
 * вердикт). Немой стоп-алерт без плана ЗАПРЕЩЁН как класс — этот текст строится
 * всегда при срабатывании CB. Без LLM (алерт обязан дойти). Голосом Бориса.
 */
export function formatCbStoppedPlan(input: { changes: CbStoppedChange[] }): string {
  const cs = input.changes
  if (cs.length === 0) {
    return 'Предохранитель остановил пачку правок ставок — план пуст (это само по себе странно, посмотри логи).'
  }
  const dRub = (c: CbStoppedChange) => (c.toMicro - c.fromMicro) / MICRO
  const ups = cs.filter((c) => dRub(c) > 0)
  const downs = cs.filter((c) => dRub(c) < 0)
  const deltas = cs.map(dRub)
  const label = (v: BidVerdict) =>
    v === 'promote' ? 'подъём' : v === 'demote' ? 'вниз к минимуму' : 'держим'
  const top = [...cs].sort((a, b) => Math.abs(dRub(b)) - Math.abs(dRub(a))).slice(0, CB_ALERT_TOP_N)
  return [
    `Предохранитель остановил пачку правок ставок (${cs.length} шт.) — вне паттерна, нужен разбор.`,
    `↑ вверх: ${ups.length}, ↓ вниз: ${downs.length}; ` +
      `Δ ${Math.round(Math.min(...deltas))}..${Math.round(Math.max(...deltas))} ₽.`,
    'Крупнейшие правки:',
    ...top.map(
      (c) =>
        `• «${c.keyText}» ${Math.round(c.fromMicro / MICRO)}→${Math.round(c.toMicro / MICRO)} ₽ (${label(c.verdict)})`
    ),
  ].join('\n')
}
