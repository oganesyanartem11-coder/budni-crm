/**
 * Тесты зоны score/ полигона Бориса-Директа.
 * Чистая синтетика: руками собранные RunResult/OracleVerdicts, без сети,
 * без Math.random/Date.now. fs — только через временный каталог ОС.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_WEIGHTS,
  type CapturedAction,
  type CategoryKey,
  type DecisionRecord,
  type OracleVerdicts,
  type ReasonCode,
  type RunResult,
  type ScenarioScore,
} from '../types'
import { assertNoNegativesOnNoise, compareDecisionSets } from './metamorphic'
import { renderMarkdown, summarize, writeResults } from './report'
import { type ScoreInput, scoreRun } from './scorer'

// ============================================================
// Фабрики синтетики
// ============================================================

/** 1 ₽ в микроединицах ставки. */
const RUB = 1_000_000
/** Цены клика по уровням TV, ₽: бинарная шкала Директа. */
const CPC: Record<number, number> = { 15: 10, 65: 50, 75: 80, 85: 120, 100: 200 }

function makeRun(over: Partial<RunResult> = {}): RunResult {
  return {
    scenarioId: 'scn-1',
    set: 'tuning',
    seed: 42,
    policy: 'boris',
    days: 30,
    spendRub: 1000,
    leads: 10,
    leadsObserved: 10,
    actions: [],
    decisions: [],
    proposals: [],
    alerts: [],
    reliability: { crashed: false, silentOnBrokenData: false },
    ...over,
  }
}

function makeOracle(over: Partial<OracleVerdicts> = {}): OracleVerdicts {
  return {
    mustMinus: new Set(),
    mustKeep: new Set(),
    optimalTv: new Map(),
    causeCodes: {},
    attributionInferable: new Map(),
    attributionOmniscient: new Map(),
    ...over,
  }
}

/** Семантика минусов для тестов: минус режет запрос, если входит подстрокой. */
const substrMatch = (negatives: string[], query: string): boolean =>
  negatives.some((n) => n.length > 0 && query.includes(n))

function makeInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    run: makeRun(),
    oracle: makeOracle(),
    // Экономика по умолчанию: ленивый 5 заявок, оракул 20 — есть зазор.
    lazyRun: makeRun({ policy: 'lazy', leads: 5 }),
    oracleRun: makeRun({ policy: 'oracle', leads: 20 }),
    attributionRefs: { omniscient: new Map(), inferable: new Map() },
    quarantineUntilDay: 0,
    expectedAnomalies: [],
    memoryScenario: false,
    negativesMatch: substrMatch,
    startBids: new Map(),
    cpcByTv: CPC,
    ...over,
  }
}

const act = (day: number, type: CapturedAction['type'], payload: unknown): CapturedAction => ({
  day,
  type,
  payload,
  by: 'boris',
})
const bidSet = (day: number, keywordId: number, toMicro: number, adGroupId?: string): CapturedAction =>
  act(day, 'bid_set', [{ keywordId, toMicro, ...(adGroupId !== undefined ? { adGroupId } : {}) }])
const negSet = (day: number, negatives: string[]): CapturedAction => act(day, 'negatives_set', negatives)

const dec = (
  targetType: DecisionRecord['targetType'],
  targetId: string,
  reasonCode: ReasonCode,
  type: DecisionRecord['type'] = 'diagnosis',
): DecisionRecord => ({ type, targetType, targetId, summary: '', reasonCode, factors: {} })

const cat = (s: ScenarioScore, key: CategoryKey) => s.categories.find((c) => c.key === key)!

// ============================================================
// economics
// ============================================================

describe('economics', () => {
  it('прогон оракула как оцениваемый → 100', () => {
    const oracleRun = makeRun({ policy: 'oracle', leads: 20 })
    const s = scoreRun(makeInput({ run: oracleRun, oracleRun }))
    expect(cat(s, 'economics').score).toBe(100)
  })

  it('прогон на уровне ленивого → 0', () => {
    const s = scoreRun(makeInput({ run: makeRun({ leads: 5 }) }))
    expect(cat(s, 'economics').score).toBe(0)
    expect(cat(s, 'economics').misses.length).toBeGreaterThan(0)
  })

  it('вырожденный зазор (оракул не лучше ленивого): не хуже ленивого → 100, хуже → 50×борис/lazy', () => {
    const flatOracle = makeRun({ policy: 'oracle', leads: 5 })
    const ok = scoreRun(makeInput({ run: makeRun({ leads: 5 }), oracleRun: flatOracle }))
    expect(cat(ok, 'economics').score).toBe(100)
    const worse = scoreRun(makeInput({ run: makeRun({ leads: 2 }), oracleRun: flatOracle }))
    expect(cat(worse, 'economics').score).toBe(20) // 50 × (0.002 / 0.005)
  })
})

// ============================================================
// minus
// ============================================================

describe('minus', () => {
  it('порезанный mustKeep → штраф −25 при полном recall', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({ actions: [negSet(3, ['бесплатно', 'офис'])] }),
        oracle: makeOracle({
          mustMinus: new Set(['обеды бесплатно']),
          mustKeep: new Set(['обеды в офис']), // режется минусом «офис»
        }),
      }),
    )
    expect(cat(s, 'minus').score).toBe(75)
    expect(cat(s, 'minus').misses.join(' ')).toContain('живой')
  })

  it('recall по mustMinus: недорезанный мусор снижает долю', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({ actions: [negSet(3, ['бесплатно'])] }),
        oracle: makeOracle({ mustMinus: new Set(['обеды бесплатно', 'рецепт обедов']) }),
      }),
    )
    expect(cat(s, 'minus').score).toBe(50)
    expect(cat(s, 'minus').misses.join(' ')).toContain('рецепт обедов')
  })

  it('пустой mustMinus и ни одного negatives_set → 100', () => {
    expect(cat(scoreRun(makeInput()), 'minus').score).toBe(100)
  })
})

// ============================================================
// bids
// ============================================================

describe('bids', () => {
  const oracle = makeOracle({ optimalTv: new Map([[1, 75]]) })

  it('премиум (TV85/100) → 0 с miss «премиум»', () => {
    const s = scoreRun(makeInput({ run: makeRun({ actions: [bidSet(4, 1, 150 * RUB)] }), oracle }))
    expect(cat(s, 'bids').score).toBe(0)
    expect(cat(s, 'bids').misses.join(' ')).toContain('премиум')
  })

  it('точное попадание в optimalTv → 100 (в т.ч. стартовой ставкой без bid_set)', () => {
    const byAction = scoreRun(makeInput({ run: makeRun({ actions: [bidSet(4, 1, 90 * RUB)] }), oracle }))
    expect(cat(byAction, 'bids').score).toBe(100)
    const byStart = scoreRun(makeInput({ oracle, startBids: new Map([[1, 90 * RUB]]) }))
    expect(cat(byStart, 'bids').score).toBe(100)
  })

  it('соседний уровень (65 вместо 75) → половина кредита', () => {
    const s = scoreRun(makeInput({ run: makeRun({ actions: [bidSet(4, 1, 60 * RUB)] }), oracle }))
    expect(cat(s, 'bids').score).toBe(50)
  })
})

// ============================================================
// attribution
// ============================================================

describe('attribution', () => {
  const k1 = '79990001111@5'
  const k2 = '79990002222@6'
  const refs = () => ({
    inferable: new Map([[k1, { adGroupId: 'g1', query: null }]]),
    omniscient: new Map([
      [k1, { adGroupId: 'g1', query: null }],
      [k2, { adGroupId: 'g2', query: null }],
    ]),
  })

  it('атрибуция не эмитируется → 0', () => {
    const s = scoreRun(makeInput({ attributionRefs: refs() }))
    expect(cat(s, 'attribution').score).toBe(0)
    expect(cat(s, 'attribution').misses).toContain('атрибуция не эмитируется')
  })

  it('непознаваемые не в знаменателе; miss «непознаваемых: N»', () => {
    const s = scoreRun(
      makeInput({
        attributionRefs: refs(),
        borisAttribution: [
          { leadKey: k1, adGroupId: 'g1', query: null, matchedBy: 'yclid' }, // верно
          { leadKey: k2, adGroupId: 'g9', query: null, matchedBy: 'utm' }, // непознаваемая — вне знаменателя
        ],
      }),
    )
    expect(cat(s, 'attribution').score).toBe(100)
    expect(cat(s, 'attribution').misses.join(' ')).toContain('непознаваемых: 1')
  })

  it('неверная группа по познаваемой → 0; все вне inferable → нейтрально 50', () => {
    const wrong = scoreRun(
      makeInput({
        attributionRefs: refs(),
        borisAttribution: [{ leadKey: k1, adGroupId: 'g9', query: null, matchedBy: 'utm' }],
      }),
    )
    expect(cat(wrong, 'attribution').score).toBe(0)
    const neutral = scoreRun(
      makeInput({
        attributionRefs: refs(),
        borisAttribution: [{ leadKey: k2, adGroupId: 'g2', query: null, matchedBy: 'utm' }],
      }),
    )
    expect(cat(neutral, 'attribution').score).toBe(50)
  })
})

// ============================================================
// diagnosis
// ============================================================

describe('diagnosis', () => {
  it('совпал код → 1; замечен, но код другой → 0.25; не замечен → 0', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({
          decisions: [
            dec('query', 'обеды бесплатно', 'STRUCTURAL_TRASH', 'minus'), // 1
            dec('keyword', '1', 'TAIL_MIN_TV', 'bid'), // 0.25 (истина PROVEN_CONVERTER_VOLUME)
            // campaign не замечен вовсе → 0
          ],
        }),
        oracle: makeOracle({
          causeCodes: {
            'query:обеды бесплатно': 'STRUCTURAL_TRASH',
            'keyword:1': 'PROVEN_CONVERTER_VOLUME',
            campaign: 'FORM_DROPOFF',
          },
        }),
      }),
    )
    expect(cat(s, 'diagnosis').score).toBe(41.67) // (1 + 0.25 + 0)/3 × 100
    expect(cat(s, 'diagnosis').misses).toHaveLength(2)
  })
})

// ============================================================
// anomalies
// ============================================================

describe('anomalies', () => {
  it('поимка в окне [day, day+2]; ложный — только вне ±2; один ложный бюджетный', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({
          alerts: [
            { day: 11, kind: 'form_break', text: 'заявки в ноль при живых визитах' }, // поймана
            { day: 9, kind: 'просадка', text: 'что-то странное' }, // в ±2 от дня 10 → НЕ ложный
            { day: 20, kind: 'шум', text: 'ложный №1 — бюджетный' },
            { day: 25, kind: 'шум', text: 'ложный №2 — штраф' },
          ],
        }),
        expectedAnomalies: [{ day: 10, kind: 'form_break' }],
      }),
    )
    expect(cat(s, 'anomalies').score).toBe(90) // recall 100 − 10×1
  })

  it('пропущенная аномалия роняет recall', () => {
    const s = scoreRun(makeInput({ expectedAnomalies: [{ day: 10, kind: 'form_break' }] }))
    expect(cat(s, 'anomalies').score).toBe(0)
    expect(cat(s, 'anomalies').misses.join(' ')).toContain('form_break')
  })
})

// ============================================================
// discipline
// ============================================================

describe('discipline', () => {
  it('применённое действие в карантине → −25 за факт', () => {
    const s = scoreRun(
      makeInput({ run: makeRun({ actions: [negSet(3, ['мусор'])] }), quarantineUntilDay: 7 }),
    )
    expect(cat(s, 'discipline').score).toBe(75)
  })

  it('«пила» по фразе (≥2 смен направления) → −10 за фразу, плоско', () => {
    const base = { startBids: new Map([[1, 90 * RUB]]) }
    const saw = scoreRun(
      makeInput({
        ...base,
        run: makeRun({ actions: [bidSet(2, 1, 100 * RUB), bidSet(3, 1, 80 * RUB), bidSet(4, 1, 100 * RUB)] }),
      }),
    )
    expect(cat(saw, 'discipline').score).toBe(90) // 2 смены направления
    const longerSaw = scoreRun(
      makeInput({
        ...base,
        run: makeRun({
          actions: [bidSet(2, 1, 100 * RUB), bidSet(3, 1, 80 * RUB), bidSet(4, 1, 100 * RUB), bidSet(5, 1, 70 * RUB)],
        }),
      }),
    )
    expect(cat(longerSaw, 'discipline').score).toBe(90) // 3 смены — штраф тот же
  })

  it('suspend кампании без катастрофы → −50; при катастрофе штрафа нет', () => {
    const suspend = makeRun({ actions: [act(5, 'campaign_suspend', {})] })
    const noCat = scoreRun(makeInput({ run: suspend }))
    expect(cat(noCat, 'discipline').score).toBe(50)
    const withCat = scoreRun(
      makeInput({ run: suspend, expectedAnomalies: [{ day: 4, kind: 'intraday_budget_runaway' }] }),
    )
    expect(cat(withCat, 'discipline').score).toBe(100)
  })
})

// ============================================================
// memory
// ============================================================

describe('memory', () => {
  const memoryBase = {
    memoryScenario: true,
    regimeDay: 5,
    oracle: makeOracle({ optimalTv: new Map([[1, 75]]) }), // пост-фазный эталон
    startBids: new Map([[1, 20 * RUB]]), // стартовый уровень TV15
  }

  it('не memory-сценарий → нейтрально 100', () => {
    expect(cat(scoreRun(makeInput()), 'memory').score).toBe(100)
  })

  it('финал в optimalTv → 100; не менял после regimeDay → 30; менял, но мимо → 60', () => {
    const adapted = scoreRun(makeInput({ ...memoryBase, run: makeRun({ actions: [bidSet(10, 1, 90 * RUB)] }) }))
    expect(cat(adapted, 'memory').score).toBe(100)

    const frozen = scoreRun(makeInput({ ...memoryBase, run: makeRun() }))
    expect(cat(frozen, 'memory').score).toBe(30)

    const missed = scoreRun(makeInput({ ...memoryBase, run: makeRun({ actions: [bidSet(10, 1, 60 * RUB)] }) }))
    expect(cat(missed, 'memory').score).toBe(60)
  })

  it('REGIME_CHANGE в decisions → нота в misses, баллы не меняются', () => {
    const s = scoreRun(
      makeInput({
        ...memoryBase,
        run: makeRun({
          actions: [bidSet(10, 1, 90 * RUB)],
          decisions: [dec('campaign', 'campaign', 'REGIME_CHANGE')],
        }),
      }),
    )
    expect(cat(s, 'memory').score).toBe(100)
    expect(cat(s, 'memory').misses.join(' ')).toContain('REGIME_CHANGE')
  })
})

// ============================================================
// Ворота надёжности и итог
// ============================================================

describe('ворота надёжности', () => {
  it('без падений итог выше 40, с crashed → ровно min(total, 40) и флаг', () => {
    const clean = scoreRun(makeInput())
    expect(clean.total).toBeGreaterThan(40)
    expect(clean.reliabilityGateTripped).toBe(false)

    const crashed = scoreRun(makeInput({ run: makeRun({ reliability: { crashed: true, silentOnBrokenData: false } }) }))
    expect(crashed.total).toBe(40)
    expect(crashed.reliabilityGateTripped).toBe(true)

    const silent = scoreRun(makeInput({ run: makeRun({ reliability: { crashed: false, silentOnBrokenData: true } }) }))
    expect(silent.total).toBeLessThanOrEqual(40)
    expect(silent.reliabilityGateTripped).toBe(true)
  })

  it('total — взвешенная сумма категорий', () => {
    const s = scoreRun(makeInput())
    const expected = s.categories.reduce((sum, c) => sum + (c.score * CATEGORY_WEIGHTS[c.key]) / 100, 0)
    expect(s.total).toBeCloseTo(expected, 2)
  })
})

// ============================================================
// rightForWrongReason
// ============================================================

describe('rightForWrongReason', () => {
  it('верное действие с неверным кодом считается; с верным — нет', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({
          actions: [negSet(5, ['обеды бесплатно']), bidSet(6, 1, 90 * RUB)],
          decisions: [
            dec('query', 'обеды бесплатно', 'DATA_NO_CONV', 'minus'), // верный минус, код мимо
            dec('keyword', '1', 'PROVEN_CONVERTER_VOLUME', 'bid'), // верная ставка, код верный
          ],
        }),
        oracle: makeOracle({
          mustMinus: new Set(['обеды бесплатно']),
          optimalTv: new Map([[1, 75]]),
          causeCodes: {
            'query:обеды бесплатно': 'STRUCTURAL_TRASH',
            'keyword:1': 'PROVEN_CONVERTER_VOLUME',
          },
        }),
      }),
    )
    expect(s.rightForWrongReasonPct).toBe(50) // 1 из 2 верных действий — по неверной причине
  })

  it('без эталонных кодов метрика не считается (0)', () => {
    const s = scoreRun(
      makeInput({
        run: makeRun({ actions: [negSet(5, ['обеды бесплатно'])] }),
        oracle: makeOracle({ mustMinus: new Set(['обеды бесплатно']) }),
      }),
    )
    expect(s.rightForWrongReasonPct).toBe(0)
  })
})

// ============================================================
// report: summarize / renderMarkdown / writeResults
// ============================================================

function mkScore(
  over: Partial<Omit<ScenarioScore, 'categories'>> & { catScores?: Partial<Record<CategoryKey, number>> } = {},
): ScenarioScore {
  const { catScores, ...rest } = over
  return {
    scenarioId: 'scn-1',
    set: 'tuning',
    seed: 1,
    policy: 'boris',
    categories: (Object.keys(CATEGORY_WEIGHTS) as CategoryKey[]).map((key) => ({
      key,
      score: catScores?.[key] ?? 100,
      misses: [],
    })),
    total: 100,
    reliabilityGateTripped: false,
    rightForWrongReasonPct: 0,
    ...rest,
  }
}

describe('report', () => {
  const scores = [
    mkScore({ scenarioId: 'a', seed: 1, total: 80, catScores: { economics: 100 }, rightForWrongReasonPct: 20 }),
    mkScore({
      scenarioId: 'b',
      seed: 2,
      total: 60,
      catScores: { economics: 50 },
      reliabilityGateTripped: true,
      rightForWrongReasonPct: 40,
    }),
    mkScore({ policy: 'lazy', scenarioId: 'a', seed: 1, total: 10 }),
  ]

  it('summarize группирует по policy×set и усредняет', () => {
    const sums = summarize(scores)
    expect(sums).toHaveLength(2)
    const boris = sums.find((s) => s.policy === 'boris')!
    expect(boris.set).toBe('tuning')
    expect(boris.scenarios).toBe(2)
    expect(boris.seeds).toBe(2)
    expect(boris.meanTotal).toBe(70)
    expect(boris.stdTotal).toBe(10) // популяционная σ для [80, 60]
    expect(boris.byCategory.economics).toBe(75)
    expect(boris.byCategory.diagnosis).toBe(100)
    expect(boris.rightForWrongReasonPct).toBe(30)
    expect(boris.reliabilityTrips).toBe(1)
    expect(sums.find((s) => s.policy === 'lazy')!.meanTotal).toBe(10)
  })

  it('renderMarkdown содержит таблицы: калибровку, категории, топ-промахи ≤ 25', () => {
    const sums = summarize(scores)
    const md = renderMarkdown(sums, {
      title: 'Матрица полигона',
      calibration: sums.filter((s) => s.policy === 'lazy'),
      topMisses: Array.from({ length: 26 }, (_, i) => ({
        scenarioId: `scn-${i + 1}`,
        policy: 'boris',
        miss: `промах №${i + 1}`,
      })),
    })
    expect(md).toContain('# Матрица полигона')
    expect(md).toContain('## Калибровочная линейка')
    expect(md).toContain('## Категории по policy × set')
    expect(md).toContain('| Политика |')
    expect(md).toContain('| boris | tuning |')
    expect(md).toContain('70.0 ± 10.0')
    expect(md).toContain('промах №25')
    expect(md).not.toContain('промах №26') // обрезано на 25
    expect(md).toContain('и ещё 1')
  })

  it('writeResults пишет scores.json/summaries.json/summary.md (mkdir recursive)', () => {
    const sums = summarize(scores)
    const md = renderMarkdown(sums, { title: 'Матрица', topMisses: [] })
    const dir = join(mkdtempSync(join(tmpdir(), 'boris-score-')), 'вложенный', 'каталог')
    writeResults(dir, scores, sums, md)
    expect(JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8'))).toHaveLength(3)
    expect(JSON.parse(readFileSync(join(dir, 'summaries.json'), 'utf8'))).toHaveLength(2)
    expect(existsSync(join(dir, 'summary.md'))).toBe(true)
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('# Матрица')
  })
})

// ============================================================
// metamorphic
// ============================================================

describe('metamorphic', () => {
  it('идентичные прогоны → ok', () => {
    const a = makeRun({ actions: [negSet(3, ['мусор']), bidSet(2, 1, 60 * RUB, 'g1'), bidSet(5, 1, 90 * RUB, 'g1')] })
    expect(compareDecisionSets(a, a)).toEqual({ ok: true, diffs: [] })
  })

  it('ловит расхождение минусов и знака финального сдвига ставки', () => {
    const a = makeRun({ actions: [negSet(3, ['мусор']), bidSet(2, 1, 60 * RUB), bidSet(5, 1, 90 * RUB)] }) // вверх
    const b = makeRun({ actions: [bidSet(2, 1, 90 * RUB), bidSet(5, 1, 60 * RUB)] }) // вниз, минуса нет
    const res = compareDecisionSets(a, b)
    expect(res.ok).toBe(false)
    expect(res.diffs.join(' ')).toContain('мусор')
    expect(res.diffs.join(' ')).toContain('фраза 1')
  })

  it('уважает релейбл групп для B', () => {
    const a = makeRun({ actions: [bidSet(2, 1, 60 * RUB, 'g1'), bidSet(5, 1, 90 * RUB, 'g1')] })
    const b = makeRun({ actions: [bidSet(2, 1, 60 * RUB, 'gX'), bidSet(5, 1, 90 * RUB, 'gX')] })
    expect(compareDecisionSets(a, b).ok).toBe(false) // без релейбла группы расходятся
    expect(compareDecisionSets(a, b, new Map([['gX', 'g1']])).ok).toBe(true)
  })

  it('assertNoNegativesOnNoise: ноль минусов за прогон, «поставил и откатил» — нарушение', () => {
    expect(assertNoNegativesOnNoise(makeRun())).toEqual({ ok: true, negatives: 0 })
    const run = makeRun({ actions: [negSet(3, ['бесплатно']), negSet(5, [])] })
    expect(assertNoNegativesOnNoise(run)).toEqual({ ok: false, negatives: 1 })
  })
})
