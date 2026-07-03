/**
 * СКОРЕР ПОЛИГОНА БОРИСА-ДИРЕКТА.
 *
 * Чистая детерминированная свёртка: прогон политики (RunResult) + вердикты
 * оракула (OracleVerdicts) → ScenarioScore по категориям CATEGORY_WEIGHTS.
 * Никакой сети/БД/часов/Math.random — только вход. Каждый промах пишется
 * человекочитаемой строкой в misses[] своей категории (сырьё для разбора).
 *
 * Правда мира скореру доступна (leads = НАСТОЯЩИЕ заявки, вердикты оракула),
 * Борис же играл только по наблюдаемому — в этом и смысл оценки.
 */

import {
  CATEGORY_WEIGHTS,
  type CategoryScore,
  type DecisionRecord,
  type OracleVerdicts,
  type RunResult,
  type ScenarioScore,
} from '../types'

// ============================================================
// Именованные пороги и штрафы (все «магические числа» — здесь)
// ============================================================

/** Ворота надёжности: упал или промолчал на битых данных → total не выше этого. */
const RELIABILITY_CAP = 40
/** Вырожденная экономика (оракул не лучше ленивого): хуже ленивого → 50×(run/lazy). */
const DEGENERATE_BELOW_FACTOR = 50
/** Минус: каждый порезанный mustKeep-запрос — это деньги живых заявок. */
const MUSTKEEP_CUT_PENALTY = 25
/** Атрибуция: пустой знаменатель (ни одной познаваемой среди эмитированных) — нейтрально. */
const ATTRIBUTION_NEUTRAL_SCORE = 50
/** Ставки: попадание в соседний уровень TV — половина кредита. */
const NEIGHBOR_TV_CREDIT = 0.5
/** Ставки: с этого уровня TV начинается запрещённый премиум. */
const PREMIUM_TV_MIN = 85
/** Диагноз: субъект замечен, но причина не понята — частичный кредит. */
const PARTIAL_DIAGNOSIS_CREDIT = 0.25
/** Аномалии: алёрт засчитывается в окне [day, day+2] от истинного дня. */
const ANOMALY_WINDOW_DAYS = 2
/** Аномалии: штраф за каждый ложный алёрт сверх бюджетного. */
const FALSE_ALERT_PENALTY = 10
/** Аномалии: один «бюджетный» ложный алёрт прощается. */
const FREE_FALSE_ALERTS = 1
/** Дисциплина: применённое действие в карантине. */
const QUARANTINE_ACTION_PENALTY = 25
/** Дисциплина: плоский штраф за фразу-«пилу» (за фразу, не за каждую смену). */
const SAW_PENALTY = 10
/** Дисциплина: со скольких смен направления ставки фраза считается «пилой». */
const SAW_FLIPS_MIN = 2
/** Дисциплина: предложений больше этого числа — проверяем на спам. */
const PROPOSAL_SPAM_LIMIT = 3
/** Дисциплина: спам предложений (большинство неверных). */
const PROPOSAL_SPAM_PENALTY = 15
/** Дисциплина: suspend кампании без катастрофы в сценарии. */
const SUSPEND_NO_CATASTROPHE_PENALTY = 50
/** Память: столько дней даём на перестройку после regime-события. */
const MEMORY_ADAPT_DAYS = 7
/** Память: не менял ставок после regime-события — живёт в устаревшей картине. */
const MEMORY_NO_CHANGE_SCORE = 30
/** Память: перестраивался после события, но финальный уровень мимо эталона. */
const MEMORY_MISSED_SCORE = 60
/** Катастрофа расхода в ожиданиях сценария (intraday_budget_runaway и родня). */
const CATASTROPHE_KIND_RE = /runaway|emergency|катастроф/i
/** Микроединицы ставок: 1 ₽ = 10^6 микро. */
const MICRO_PER_RUB = 1_000_000

// ============================================================
// Вход скорера (собирает раннер)
// ============================================================

export interface ScoreInput {
  /** Оцениваемый прогон (обычно Борис, но скорер политику не различает). */
  run: RunResult
  /** Вердикты оракула по этому (сценарий, зерно). */
  oracle: OracleVerdicts
  /** Прогон ленивого бота — нижняя планка экономики. */
  lazyRun: RunResult
  /** Прогон оракула-политики — верхняя планка экономики. */
  oracleRun: RunResult
  /** Эталоны атрибуции: всезнающий и «лучший вывод из наблюдаемого». */
  attributionRefs: {
    omniscient: Map<string, { adGroupId: string; query: string | null }>
    inferable: Map<string, { adGroupId: string; query: string | null }>
  }
  /** Атрибуция, которую эмитировал Борис (нет/пусто → категория 0). */
  borisAttribution?: Array<{ leadKey: string; adGroupId: string | null; query: string | null; matchedBy: string }>
  /** До какого дня кампания «молодая» (0 = карантина нет). */
  quarantineUntilDay: number
  /** Истинные аномалии сценария (из expectations). */
  expectedAnomalies: Array<{ day: number; kind: string }>
  /** Сценарий на память (regime_change)? Иначе memory нейтральна (100). */
  memoryScenario: boolean
  /** Семантика минусов движка — раннер передаёт engine.negativesMatch. */
  negativesMatch: (negatives: string[], query: string) => boolean
  /** Стартовые ставки фраз (в RunResult их нет): keywordId → микро. */
  startBids: Map<number, number>
  /** Цены уровней TV из конфига сценария, ₽ за клик: {15: .., 65: ..}. */
  cpcByTv: Record<number, number>
  /** День regime-события (нужен memory-сценариям). */
  regimeDay?: number
}

// ============================================================
// Общие помощники (переиспользует metamorphic.ts)
// ============================================================

const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v))
const round2 = (v: number): number => Math.round(v * 100) / 100
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length)

/** Итоговый список минус-фраз на конец прогона (последний negatives_set; не трогал → []). */
export function finalNegatives(run: RunResult): string[] {
  let last: string[] = []
  for (const a of run.actions) {
    if (a.type === 'negatives_set' && Array.isArray(a.payload)) last = a.payload as string[]
  }
  return last
}

export interface BidPoint {
  day: number
  toMicro: number
  /** Фейк может писать группу в payload — метаморфике пригодится. */
  adGroupId?: string
}

/** Последовательности bid_set по каждой фразе, в порядке действий прогона. */
export function bidSequences(run: RunResult): Map<number, BidPoint[]> {
  const map = new Map<number, BidPoint[]>()
  for (const a of run.actions) {
    if (a.type !== 'bid_set' || !Array.isArray(a.payload)) continue
    for (const raw of a.payload as Array<{ keywordId: number; toMicro: number; adGroupId?: string }>) {
      if (typeof raw?.keywordId !== 'number' || typeof raw?.toMicro !== 'number') continue
      const seq = map.get(raw.keywordId) ?? []
      seq.push({ day: a.day, toMicro: raw.toMicro, adGroupId: raw.adGroupId })
      map.set(raw.keywordId, seq)
    }
  }
  return map
}

/** Достигнутый уровень TV: максимальный tv, чья цена (₽→микро) ≤ ставке; null = ниже всех. */
function achievedTv(bidMicro: number, cpcByTv: Record<number, number>): number | null {
  let best: number | null = null
  for (const [tvStr, priceRub] of Object.entries(cpcByTv)) {
    const tv = Number(tvStr)
    if (priceRub * MICRO_PER_RUB <= bidMicro && (best === null || tv > best)) best = tv
  }
  return best
}

/** Уровни шкалы TV по возрастанию (из cpcByTv сценария). */
function tvLevels(cpcByTv: Record<number, number>): number[] {
  return Object.keys(cpcByTv)
    .map(Number)
    .sort((a, b) => a - b)
}

/**
 * Ранг уровня на шкале: null (ниже всех) → −1; уровень вне шкалы (например,
 * эталон TV55 при шкале 15/65/75) — между соседями (полуцелый ранг).
 * «Соседний уровень» = |ранг−ранг| ≤ 1.
 */
function tvRank(tv: number | null, levels: number[]): number {
  if (tv === null) return -1
  const i = levels.indexOf(tv)
  if (i >= 0) return i
  return levels.filter((l) => l < tv).length - 0.5
}

const tvName = (tv: number | null): string => (tv === null ? 'ниже минимального' : `TV${tv}`)

/** Финальная ставка фразы: последний bid_set, иначе стартовая; undefined = неизвестна. */
function finalBidMicro(kwId: number, seqs: Map<number, BidPoint[]>, startBids: Map<number, number>): number | undefined {
  const seq = seqs.get(kwId)
  if (seq && seq.length > 0) return seq[seq.length - 1].toMicro
  return startBids.get(kwId)
}

/** Subject-ключ решения — тот же формат, что ключи oracle.causeCodes. */
function subjectOf(d: DecisionRecord): string {
  if (d.targetType === 'campaign') return 'campaign'
  return `${d.targetType}:${d.targetId}`
}

// ============================================================
// Категории
// ============================================================

/** economics (30): доля захваченного зазора «ленивый → оракул» по заявкам-на-рубль. */
function scoreEconomics(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  // Метрика — НАСТОЯЩИЕ заявки на рубль (правда мира, не leadsObserved).
  const lpr = (r: RunResult): number => r.leads / Math.max(r.spendRub, 1)
  const runLpr = lpr(input.run)
  const lazyLpr = lpr(input.lazyRun)
  const oracleLpr = lpr(input.oracleRun)
  const denom = oracleLpr - lazyLpr
  let score: number
  if (denom <= 0) {
    // Вырожденный сценарий: оракул не лучше ленивого — не хуже ленивого и достаточно.
    if (runLpr >= lazyLpr) {
      score = 100
    } else {
      score = lazyLpr > 0 ? DEGENERATE_BELOW_FACTOR * (runLpr / lazyLpr) : 100
      misses.push(
        `экономика: вырожденный сценарий, но Борис хуже ленивого (${runLpr.toFixed(4)} < ${lazyLpr.toFixed(4)} заявок/₽)`,
      )
    }
  } else {
    const capture = clamp((runLpr - lazyLpr) / denom, 0, 1)
    score = capture * 100
    if (capture < 1) {
      misses.push(
        `экономика: захвачено ${(capture * 100).toFixed(0)}% зазора — заявок/₽: Борис ${runLpr.toFixed(4)}, ленивый ${lazyLpr.toFixed(4)}, оракул ${oracleLpr.toFixed(4)}`,
      )
    }
  }
  return { key: 'economics', score: round2(clamp(score)), misses }
}

/** minus (10): recall по mustMinus минус штрафы за порезанный живой трафик (mustKeep). */
function scoreMinus(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  const negatives = finalNegatives(input.run)
  const mustMinus = [...input.oracle.mustMinus]
  // Пустой mustMinus → recall 100 (резать было нечего).
  let recall = 1
  if (mustMinus.length > 0) {
    let cut = 0
    for (const q of mustMinus) {
      if (input.negativesMatch(negatives, q)) cut++
      else misses.push(`минус: мусор «${q}» так и не порезан`)
    }
    recall = cut / mustMinus.length
  }
  let penalty = 0
  for (const q of input.oracle.mustKeep) {
    if (input.negativesMatch(negatives, q)) {
      penalty += MUSTKEEP_CUT_PENALTY
      misses.push(`минус: порезан живой запрос «${q}» — деньги живых заявок (−${MUSTKEEP_CUT_PENALTY})`)
    }
  }
  return { key: 'minus', score: round2(clamp(recall * 100 - penalty)), misses }
}

/** bids (10): финальная ставка каждой фразы против optimalTv оракула. */
function scoreBids(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  const seqs = bidSequences(input.run)
  const levels = tvLevels(input.cpcByTv)
  const credits: number[] = []
  for (const [kwId, optimal] of input.oracle.optimalTv) {
    if (optimal === null) continue // не трогать/недостижимо — не оцениваем
    const bid = finalBidMicro(kwId, seqs, input.startBids)
    if (bid === undefined) {
      credits.push(0)
      misses.push(`ставки: фраза ${kwId} — нет ни ставки Бориса, ни стартовой (эталон TV${optimal})`)
      continue
    }
    const got = achievedTv(bid, input.cpcByTv)
    if (got !== null && got >= PREMIUM_TV_MIN) {
      credits.push(0)
      misses.push(`ставки: фраза ${kwId} закуплена на ${tvName(got)} — премиум запрещён (эталон TV${optimal})`)
      continue
    }
    if (got === optimal) {
      credits.push(1)
      continue
    }
    const dist = Math.abs(tvRank(got, levels) - tvRank(optimal, levels))
    if (dist <= 1) {
      credits.push(NEIGHBOR_TV_CREDIT)
      misses.push(`ставки: фраза ${kwId} на соседнем уровне ${tvName(got)} вместо TV${optimal} (кредит ${NEIGHBOR_TV_CREDIT})`)
    } else {
      credits.push(0)
      misses.push(`ставки: фраза ${kwId} на ${tvName(got)} вместо TV${optimal}`)
    }
  }
  // Нет фраз с эталоном → категория нейтральна.
  const score = credits.length > 0 ? mean(credits) * 100 : 100
  return { key: 'bids', score: round2(clamp(score)), misses }
}

/** attribution (10): доля верных групп среди познаваемых заявок; непознаваемые не штрафуются. */
function scoreAttribution(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  const boris = input.borisAttribution
  if (!boris || boris.length === 0) {
    return { key: 'attribution', score: 0, misses: ['атрибуция не эмитируется'] }
  }
  const { inferable, omniscient } = input.attributionRefs
  let graded = 0
  let correct = 0
  for (const rec of boris) {
    const ref = inferable.get(rec.leadKey)
    // Непознаваемая заявка (нет в inferable) — исключаем: Борис не мог знать,
    // даже если уверенно назначил группу по utm_term.
    if (!ref) continue
    graded++
    if (rec.adGroupId === ref.adGroupId) correct++
    else misses.push(`атрибуция: заявка ${rec.leadKey} → «${rec.adGroupId ?? '∅'}», верно «${ref.adGroupId}» (matchedBy=${rec.matchedBy})`)
  }
  // Зазор «всезнание − наблюдаемое»: сколько заявок в принципе непознаваемы.
  const unknowable = omniscient.size - inferable.size
  misses.push(`непознаваемых: ${unknowable} (зазор всезнание−наблюдаемое)`)
  // Все эмитированные заявки непознаваемы → судить не по чему, нейтрально 50.
  const score = graded > 0 ? (correct / graded) * 100 : ATTRIBUTION_NEUTRAL_SCORE
  return { key: 'attribution', score: round2(clamp(score)), misses }
}

/** diagnosis (20): по каждому субъекту с истинным кодом — совпал / замечен-но-не-понят / пропущен. */
function scoreDiagnosis(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  const subjects = Object.keys(input.oracle.causeCodes)
  if (subjects.length === 0) return { key: 'diagnosis', score: 100, misses }
  const bySubject = new Map<string, DecisionRecord[]>()
  for (const d of input.run.decisions) {
    const key = subjectOf(d)
    const arr = bySubject.get(key) ?? []
    arr.push(d)
    bySubject.set(key, arr)
  }
  let sum = 0
  for (const subject of subjects) {
    const want = input.oracle.causeCodes[subject]
    const ds = bySubject.get(subject) ?? []
    if (ds.length === 0) {
      misses.push(`диагноз: субъект ${subject} не замечен (истинный код ${want})`)
      continue // 0
    }
    if (ds.some((d) => d.reasonCode === want)) {
      sum += 1
      continue
    }
    // Заметил субъект, причину не понял — частичный кредит.
    sum += PARTIAL_DIAGNOSIS_CREDIT
    misses.push(
      `диагноз: ${subject} замечен, но код ${ds[ds.length - 1].reasonCode} вместо ${want} (кредит ${PARTIAL_DIAGNOSIS_CREDIT})`,
    )
  }
  return { key: 'diagnosis', score: round2(clamp((sum / subjects.length) * 100)), misses }
}

/** anomalies (8): recall по ожидаемым аномалиям − штраф за ложные алёрты сверх бюджетного. */
function scoreAnomalies(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  const alerts = input.run.alerts
  const expected = input.expectedAnomalies
  // Либеральное совпадение сути: kind алёрта ↔ ожидаемый kind подстрокой, либо суть в тексте.
  const kindMatches = (al: { kind: string; text: string }, want: string): boolean => {
    const kind = al.kind.toLowerCase()
    const text = al.text.toLowerCase()
    const w = want.toLowerCase()
    return (kind.length > 0 && (kind.includes(w) || w.includes(kind))) || text.includes(w)
  }
  // Поимка: алёрт в окне [day, day+2] от истинного дня (реакция может запаздывать).
  const catchWindow = (day: number, exp: { day: number }): boolean => day >= exp.day && day <= exp.day + ANOMALY_WINDOW_DAYS
  // Ложность: день алёрта дальше ±2 от ЛЮБОЙ ожидаемой аномалии (окно симметричное).
  const nearExpected = (day: number): boolean => expected.some((exp) => Math.abs(day - exp.day) <= ANOMALY_WINDOW_DAYS)
  let caught = 0
  for (const exp of expected) {
    if (alerts.some((al) => catchWindow(al.day, exp) && kindMatches(al, exp.kind))) caught++
    else misses.push(`аномалии: «${exp.kind}» дня ${exp.day} не поймана (окно до дня ${exp.day + ANOMALY_WINDOW_DAYS})`)
  }
  // Ложные — алёрты в дни без ожидаемой аномалии в окне ±2; один «бюджетный» прощается.
  const falseAlerts = alerts.filter((al) => !nearExpected(al.day)).length
  const penalized = Math.max(0, falseAlerts - FREE_FALSE_ALERTS)
  if (penalized > 0) {
    misses.push(`аномалии: ложных алёртов ${falseAlerts}, штраф за ${penalized} сверх ${FREE_FALSE_ALERTS} бюджетного`)
  }
  const recall = expected.length > 0 ? caught / expected.length : 1
  return { key: 'anomalies', score: round2(clamp(recall * 100 - FALSE_ALERT_PENALTY * penalized)), misses }
}

/** discipline (7): карантин, «пила» ставок, спам предложений, suspend без катастрофы. */
function scoreDiscipline(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  let score = 100

  // 1) Применённые действия в карантине: −25 за каждый write-ФАКТ (CapturedAction),
  //    не за элементы payload внутри него (пачка из 5 ставок = один факт).
  for (const a of input.run.actions) {
    if ((a.type === 'bid_set' || a.type === 'negatives_set') && a.day < input.quarantineUntilDay) {
      score -= QUARANTINE_ACTION_PENALTY
      misses.push(`дисциплина: ${a.type} в карантине (день ${a.day} < ${input.quarantineUntilDay}) −${QUARANTINE_ACTION_PENALTY}`)
    }
  }

  // 2) «Пила»: ≥ SAW_FLIPS_MIN смен направления ставки по фразе за прогон →
  //    −SAW_PENALTY за фразу (плоско, сколько бы разворотов ни было). Смену
  //    данных из RunResult не видно, поэтому сценарии пилы строятся на
  //    стационарном мире (см. каталог сценариев).
  const seqs = bidSequences(input.run)
  for (const [kwId, seq] of seqs) {
    const start = input.startBids.get(kwId)
    const values = [start ?? seq[0].toMicro, ...seq.map((p) => p.toMicro)]
    const dirs: number[] = []
    for (let i = 1; i < values.length; i++) {
      const d = Math.sign(values[i] - values[i - 1])
      if (d !== 0) dirs.push(d)
    }
    let flips = 0
    for (let i = 1; i < dirs.length; i++) if (dirs[i] !== dirs[i - 1]) flips++
    if (flips >= SAW_FLIPS_MIN) {
      score -= SAW_PENALTY
      misses.push(`дисциплина: пила по фразе ${kwId} (${flips} смен(ы) направления ставки) −${SAW_PENALTY}`)
    }
  }

  // 3) Спам предложений: больше лимита и большинство неверных.
  const props = input.run.proposals
  if (props.length > PROPOSAL_SPAM_LIMIT) {
    const wrong = props.filter((p) => !p.wasCorrect).length
    if (wrong * 2 > props.length) {
      score -= PROPOSAL_SPAM_PENALTY
      misses.push(`дисциплина: спам предложений (${props.length} шт., неверных ${wrong}) −${PROPOSAL_SPAM_PENALTY}`)
    }
  }

  // 4) Suspend кампании без катастрофы расхода в сценарии.
  const suspended = input.run.actions.some((a) => a.type === 'campaign_suspend')
  const hadCatastrophe = input.expectedAnomalies.some((e) => CATASTROPHE_KIND_RE.test(e.kind))
  if (suspended && !hadCatastrophe) {
    score -= SUSPEND_NO_CATASTROPHE_PENALTY
    misses.push(`дисциплина: suspend кампании без катастрофы в сценарии −${SUSPEND_NO_CATASTROPHE_PENALTY}`)
  }

  return { key: 'discipline', score: round2(clamp(score)), misses }
}

/**
 * memory (5): после regime-события Борис обязан слезть с устаревшей картины мира.
 *
 * ВАЖНО: переданный oracle для memory-сценариев считается ПОСТ-фазным —
 * optimalTv отражает мир ПОСЛЕ regime_change («куда надо было прийти»),
 * поэтому сравнение финального уровня с ним и есть проверка перестройки.
 * Шкала по фразе: попал в optimalTv → 100; вообще не менял ставку после
 * regimeDay → 30 (живёт до-историей); менял, но мимо → 60. Итог — среднее.
 */
function scoreMemory(input: ScoreInput): CategoryScore {
  const misses: string[] = []
  // Не memory-сценарий → нейтрально, чтобы не размывать разницу политик.
  if (!input.memoryScenario) return { key: 'memory', score: 100, misses }

  if (input.run.decisions.some((d) => d.reasonCode === 'REGIME_CHANGE')) {
    misses.push('memory: REGIME_CHANGE распознан Борисом (нота, на баллы не влияет)')
  }
  const regimeDay = input.regimeDay
  if (regimeDay === undefined) {
    misses.push('memory: regimeDay не передан раннером — категория нейтральна')
    return { key: 'memory', score: 100, misses }
  }
  // Судим финал только когда прошёл дедлайн адаптации regimeDay + MEMORY_ADAPT_DAYS.
  const deadline = regimeDay + MEMORY_ADAPT_DAYS
  if (input.run.days <= deadline) {
    misses.push(`memory: прогон короче дедлайна адаптации (день ${deadline}) — категория нейтральна`)
    return { key: 'memory', score: 100, misses }
  }

  const seqs = bidSequences(input.run)
  const perPhrase: number[] = []
  for (const [kwId, optimal] of input.oracle.optimalTv) {
    if (optimal === null) continue
    const finalBid = finalBidMicro(kwId, seqs, input.startBids)
    if (finalBid === undefined) continue
    const gotFinal = achievedTv(finalBid, input.cpcByTv)
    if (gotFinal === optimal) {
      perPhrase.push(100) // перестроился к пост-фазному эталону
      continue
    }
    const changedAfterRegime = (seqs.get(kwId) ?? []).some((p) => p.day > regimeDay)
    if (!changedAfterRegime) {
      perPhrase.push(MEMORY_NO_CHANGE_SCORE)
      misses.push(
        `memory: фраза ${kwId} — ставка не менялась после regime-дня ${regimeDay}, держит ${tvName(gotFinal)} (эталон TV${optimal})`,
      )
    } else {
      perPhrase.push(MEMORY_MISSED_SCORE)
      misses.push(`memory: фраза ${kwId} перестраивалась, но финал ${tvName(gotFinal)} мимо эталона TV${optimal}`)
    }
  }
  const score = perPhrase.length > 0 ? mean(perPhrase) : 100
  return { key: 'memory', score: round2(clamp(score)), misses }
}

// ============================================================
// «Правильно по неверной причине»
// ============================================================

/**
 * Среди ВЕРНЫХ действий (финальная ставка в optimalTv; порезанный mustMinus) —
 * доля тех, чей reasonCode не совпал с истинным кодом субъекта.
 * Субъекты без истинного кода не считаются вовсе.
 */
function computeRightForWrongReason(input: ScoreInput): number {
  const expected = input.oracle.causeCodes
  const reasonMatched = (subject: string): boolean =>
    input.run.decisions.some((d) => subjectOf(d) === subject && d.reasonCode === expected[subject])

  let total = 0
  let wrongReason = 0

  // Верные ставки: достигнутый финальный уровень совпал с эталоном.
  const seqs = bidSequences(input.run)
  for (const [kwId, optimal] of input.oracle.optimalTv) {
    if (optimal === null) continue
    const bid = finalBidMicro(kwId, seqs, input.startBids)
    if (bid === undefined || achievedTv(bid, input.cpcByTv) !== optimal) continue
    const subject = `keyword:${kwId}`
    if (!(subject in expected)) continue
    total++
    if (!reasonMatched(subject)) wrongReason++
  }

  // Верные минусы: истинный мусор, реально порезанный финальным списком.
  const negatives = finalNegatives(input.run)
  for (const q of input.oracle.mustMinus) {
    if (!input.negativesMatch(negatives, q)) continue
    const subject = `query:${q}`
    if (!(subject in expected)) continue
    total++
    if (!reasonMatched(subject)) wrongReason++
  }

  return total > 0 ? round2((wrongReason / total) * 100) : 0
}

// ============================================================
// Свёртка
// ============================================================

export function scoreRun(input: ScoreInput): ScenarioScore {
  const categories: CategoryScore[] = [
    scoreEconomics(input),
    scoreDiagnosis(input),
    scoreBids(input),
    scoreMinus(input),
    scoreAttribution(input),
    scoreAnomalies(input),
    scoreDiscipline(input),
    scoreMemory(input),
  ]

  let total = 0
  for (const c of categories) total += (c.score * CATEGORY_WEIGHTS[c.key]) / 100

  // Ворота надёжности: падение или молчание на битых данных дисквалифицирует.
  const gateTripped = input.run.reliability.crashed || input.run.reliability.silentOnBrokenData
  if (gateTripped) total = Math.min(total, RELIABILITY_CAP)

  return {
    scenarioId: input.run.scenarioId,
    set: input.run.set,
    seed: input.run.seed,
    policy: input.run.policy,
    categories,
    total: round2(total),
    reliabilityGateTripped: gateTripped,
    rightForWrongReasonPct: computeRightForWrongReason(input),
  }
}
