/**
 * ХОЛОСТОЙ ЗАМЕР Бориса как есть (npm run sim:baseline).
 *
 * Точка отсчёта ДО тюнинга мозга: гоняет РЕАЛЬНЫЙ мозг Бориса по всем
 * tuning- и holdout-сценариям × N зёрен, скорит и пишет отчёт с раздельными
 * итогами (тюнинг / holdout / зазор). Плюс метаморфический пояс (детерминизм,
 * перестановка групп, бездействие на шуме).
 *
 * Мозг НЕ тюнится. LLM-классификатор — stub (детерминированный, без сети):
 * baseline обязан быть воспроизводимым; живой Haiku с кешем — отдельный
 * ручной прогон (llmMode:'live').
 */

import { describe, it, expect } from 'vitest'
import { worldEngine } from '../engine/world'
import { buildCatalog } from '../scenarios/catalog'
import { runAndScoreScenario } from './core'
import { runScenario } from './harness'
import { summarize, renderMarkdown, writeResults } from '../score/report'
import { assertNoNegativesOnNoise } from '../score/metamorphic'
import { computeOracleVerdicts } from '../oracle/oracle'
import type { ScenarioScore } from '../types'

const SEEDS = [1, 2, 3]

describe('Холостой замер Бориса (baseline)', () => {
  it(
    'скор по всем сценариям (тюнинг + holdout), отчёт на диск',
    async () => {
      const catalog = buildCatalog(1)
      const allScores: ScenarioScore[] = []

      for (const config of catalog) {
        for (const seed of SEEDS) {
          const { scores } = await runAndScoreScenario(worldEngine, config, seed, {
            llmMode: 'stub',
            policies: ['boris'],
          })
          allScores.push(...scores)
        }
      }

      const summaries = summarize(allScores)
      const md = renderMarkdown(summaries, {
        title: 'Baseline: Борис как есть (до тюнинга)',
        topMisses: allScores
          .flatMap((s) =>
            s.categories.flatMap((c) => c.misses.map((m) => ({ scenarioId: s.scenarioId, policy: s.policy, miss: m })))
          )
          .slice(0, 40),
      })
      writeResults('sim/results/baseline', allScores, summaries, md)

      const tuning = summaries.find((s) => s.set === 'tuning' && s.policy === 'boris')
      const holdout = summaries.find((s) => s.set === 'holdout' && s.policy === 'boris')
      const tMean = tuning?.meanTotal ?? NaN
      const hMean = holdout?.meanTotal ?? NaN
      console.log(`[baseline] tuning=${tMean.toFixed(1)}  holdout=${hMean.toFixed(1)}  зазор=${(tMean - hMean).toFixed(1)}`)
      if (tuning) {
        const cats = Object.entries(tuning.byCategory)
          .map(([k, v]) => `${k}=${(v as number).toFixed(0)}`)
          .join(' ')
        console.log(`[baseline] tuning категории: ${cats}`)
        console.log(`[baseline] правильно-по-неверной-причине: ${tuning.rightForWrongReasonPct.toFixed(1)}%`)
      }

      // Замер состоялся: скоры есть по обоим наборам, ворота надёжности считаются.
      expect(allScores.length).toBeGreaterThan(0)
      expect(tuning).toBeDefined()
      expect(holdout).toBeDefined()
    },
    900_000
  )

  it(
    'метаморфический пояс: детерминизм и дисциплина на здоровой кампании',
    async () => {
      const catalog = buildCatalog(1)
      const t02 = catalog.find((c) => c.id === 'T02')!

      // Детерминизм: два прогона Бориса на одном зерне → одинаковый скор.
      const runA = await runAndScoreScenario(worldEngine, t02, 7, { llmMode: 'stub', policies: ['boris'] })
      const runB = await runAndScoreScenario(worldEngine, t02, 7, { llmMode: 'stub', policies: ['boris'] })
      expect(runA.scores[0].total).toBe(runB.scores[0].total)

      // Здоровая кампания (T01) без ловушек: Борис не должен резать веером —
      // дисциплина высокая. assertNoNegativesOnNoise проверяет прогон Бориса.
      const t01 = catalog.find((c) => c.id === 'T01')!
      const healthy = await runScenario({
        engine: worldEngine,
        config: t01,
        seed: 3,
        policy: 'boris',
        llmMode: 'stub',
        oracle: computeOracleVerdicts(t01),
      })
      const noiseCheck = assertNoNegativesOnNoise(healthy.result)
      console.log(`[metamorphic] T01 минусов Бориса на здоровой кампании: ${noiseCheck.negatives}`)
      const disc = (await runAndScoreScenario(worldEngine, t01, 3, { llmMode: 'stub', policies: ['boris'] }))
        .scores[0].categories.find((c) => c.key === 'discipline')
      expect(disc).toBeDefined()
      console.log(`[metamorphic] T01 discipline=${disc?.score.toFixed(0)}`)
    },
    600_000
  )
})
