/**
 * ФИНАЛ Цикла 2.0 — ОДИН прогон свежего HOLDOUT-2 (после него правок нет).
 * Мозг под holdout-2 не тюнился; это честная проверка обобщения.
 * Запуск: dotenv -e .env.local -- vitest run --config sim/vitest.config.ts sim/runner/holdout2.simtest.ts
 */
import { describe, it, expect } from 'vitest'
import { worldEngine } from '../engine/world'
import { buildHoldout2 } from '../scenarios/holdout2'
import { runAndScoreScenario } from './core'
import { summarize, renderMarkdown, writeResults } from '../score/report'
import type { ScenarioScore } from '../types'

const SEEDS = [1, 2, 3, 4, 5]

describe('HOLDOUT-2 (финал Цикла 2.0)', () => {
  it(
    'скор по свежему holdout-2 (5 сценариев × 5 зёрен), отчёт на диск',
    async () => {
      const set = buildHoldout2(1)
      const all: ScenarioScore[] = []
      for (const config of set) {
        for (const seed of SEEDS) {
          const { scores } = await runAndScoreScenario(worldEngine, config, seed, {
            llmMode: 'stub',
            policies: ['boris'],
          })
          all.push(...scores)
        }
      }
      const summaries = summarize(all)
      const md = renderMarkdown(summaries, {
        title: 'HOLDOUT-2 (финал Цикла 2.0)',
        topMisses: all
          .flatMap((s) => s.categories.flatMap((c) => c.misses.map((m) => ({ scenarioId: s.scenarioId, policy: s.policy, miss: m }))))
          .slice(0, 40),
      })
      writeResults('sim/results/holdout2', all, summaries, md)

      const b = summaries.find((s) => s.policy === 'boris')!
      const c = b.byCategory
      console.log(
        `[holdout2] total=${b.meanTotal.toFixed(1)}±${b.stdTotal.toFixed(1)} eco=${c.economics.toFixed(0)} ` +
          `diag=${c.diagnosis.toFixed(0)} bids=${c.bids.toFixed(0)} minus=${c.minus.toFixed(0)} ` +
          `anom=${c.anomalies.toFixed(0)} disc=${c.discipline.toFixed(0)} mem=${c.memory.toFixed(0)} ` +
          `wrong=${b.rightForWrongReasonPct.toFixed(1)}% trips=${b.reliabilityTrips}`
      )
      // Разбор промахов по сценариям (в консоль — для финального отчёта).
      for (const s of all.filter((x) => x.seed === 1)) {
        const diag = s.categories.find((k) => k.key === 'diagnosis')!
        console.log(`[h2] ${s.scenarioId} total=${s.total.toFixed(0)} diagMiss=${diag.misses.length}`)
      }
      expect(all.length).toBe(set.length * SEEDS.length)
    },
    900_000
  )
})
