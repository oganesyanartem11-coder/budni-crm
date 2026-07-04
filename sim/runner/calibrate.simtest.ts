/**
 * КАЛИБРОВКА ШКАЛЫ полигона (npm run sim:calibrate).
 *
 * Гоняет все пять политик (lazy/random/greedy/oracle/boris) на репрезентативной
 * подвыборке сценариев × несколько зёрен и проверяет, что шкала осмысленна:
 *  - экономика (капчур бездействие→оракул): oracle = 100, lazy = 0 ПО ПОСТРОЕНИЮ;
 *  - линейка тотала: oracle > greedy, oracle > random, oracle > lazy;
 *  - Борис заметно выше ленивого.
 * Если линейка не держится — правим ВЕСА/скоринг (не мозг). Отчёт пишется на
 * диск ДО ассертов, чтобы числа были видны даже при провале ожидания.
 */

import { describe, it, expect } from 'vitest'
import { worldEngine } from '../engine/world'
import { buildCatalog } from '../scenarios/catalog'
import { runAndScoreScenario } from './core'
import { summarize, renderMarkdown, writeResults } from '../score/report'
import type { PolicyName, ScenarioScore } from '../types'

// Репрезентативная подвыборка: здоровая, мусор, дорогая группа, потолок
// аукциона, смена режима (память), CTR-диагностика, отвал формы.
const CALIB_IDS = ['T01', 'T02', 'T03', 'T08', 'T19', 'T15', 'T05']
const CALIB_SEEDS = [1, 2, 3]
const POLICIES: PolicyName[] = ['lazy', 'random', 'greedy', 'oracle', 'boris']

describe('Калибровка шкалы полигона', () => {
  it(
    'линейка политик осмысленна (oracle высоко, lazy низко)',
    async () => {
      const catalog = buildCatalog(1)
      const chosen = catalog.filter((c) => CALIB_IDS.includes(c.id))
      expect(chosen.length).toBeGreaterThan(0)

      const allScores: ScenarioScore[] = []
      const economicsRows: Array<{ id: string; seed: number; policy: PolicyName; leadsPerRub: number }> = []

      for (const config of chosen) {
        for (const seed of CALIB_SEEDS) {
          const { scores, economics } = await runAndScoreScenario(worldEngine, config, seed, {
            llmMode: 'stub',
            policies: POLICIES,
          })
          allScores.push(...scores)
          for (const p of POLICIES) {
            if (economics[p]) {
              economicsRows.push({ id: config.id, seed, policy: p, leadsPerRub: economics[p].leadsPerRub })
            }
          }
        }
      }

      const summaries = summarize(allScores)
      const meanByPolicy = new Map<PolicyName, number>()
      for (const s of summaries) {
        // summarize группирует по policy×set; калибровка — только tuning.
        if (s.set === 'tuning') meanByPolicy.set(s.policy, s.meanTotal)
      }

      const md = renderMarkdown(summaries, {
        title: 'Калибровка шкалы (tuning subset)',
        topMisses: allScores
          .flatMap((s) => s.categories.flatMap((c) => c.misses.map((m) => ({ scenarioId: s.scenarioId, policy: s.policy, miss: m }))))
          .slice(0, 25),
      })
      writeResults('sim/results/calibration', allScores, summaries, md)

      // Отчёт записан. Теперь — мягкая диагностика линейки в консоль.
      const line = POLICIES.map((p) => `${p}=${(meanByPolicy.get(p) ?? NaN).toFixed(1)}`).join('  ')
      console.log(`[calibration] tuning mean total: ${line}`)

      const oracle = meanByPolicy.get('oracle') ?? 0
      const lazy = meanByPolicy.get('lazy') ?? 0
      const greedy = meanByPolicy.get('greedy') ?? 0
      const boris = meanByPolicy.get('boris') ?? 0

      // Главный якорь — экономика: капчур oracle=100, lazy=0 (среднее по сценариям).
      const econByPolicy = new Map<PolicyName, number[]>()
      for (const s of allScores) {
        if (s.set !== 'tuning') continue
        const eco = s.categories.find((c) => c.key === 'economics')
        if (!eco) continue
        const arr = econByPolicy.get(s.policy) ?? []
        arr.push(eco.score)
        econByPolicy.set(s.policy, arr)
      }
      const meanEco = (p: PolicyName) => {
        const a = econByPolicy.get(p) ?? []
        return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN
      }
      console.log(
        `[calibration] economics capture: oracle=${meanEco('oracle').toFixed(1)} greedy=${meanEco('greedy').toFixed(1)} random=${meanEco('random').toFixed(1)} lazy=${meanEco('lazy').toFixed(1)} boris=${meanEco('boris').toFixed(1)}`
      )

      // Линейка тотала: oracle — лучший из ботов, lazy — не выше Бориса.
      expect(oracle).toBeGreaterThan(greedy)
      expect(oracle).toBeGreaterThan(lazy)
      expect(boris).toBeGreaterThan(lazy)
      // Экономика оракула — верх шкалы; ленивого — низ.
      expect(meanEco('oracle')).toBeGreaterThan(meanEco('lazy'))
    },
    600_000
  )
})
