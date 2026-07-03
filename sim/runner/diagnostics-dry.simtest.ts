/**
 * ШАГ 3 «догнать полигон» — ХОЛОСТОЙ ЗАМЕР новых диагнозов сессии «Прозрение».
 *
 * Гоняет РЕАЛЬНЫЙ мозг Бориса (фейки транспорта — как везде в полигоне) на
 * B2B-сценарии с ДВУМЯ вариантами:
 *   • control — без разведочных сигналов (deviceStats/noSchedule нет);
 *   • signals — перекос устройств (мобайл 0 заявок) + расписание не задано
 *     (выходные жгут бюджет).
 * Замеряем, ВЫРОСЛА ли диагностика: сколько DEVICE_SKEW/SCHEDULE_WASTE и пр.
 * эмитировал Борис. Мозг НЕ тюнится — только замер (пороги/веса не трогаем).
 *
 * Инвариант: без сигналов новые диагнозы молчат (доказывает, что базовая
 * линейка baseline не поехала — они зажигаются ТОЛЬКО от реального сигнала).
 */

import { describe, it, expect } from 'vitest'
import { worldEngine } from '../engine/world'
import { runScenario } from './harness'
import { computeOracleVerdicts } from '../oracle/oracle'
import type { ReasonCode, ScenarioConfig } from '../types'

const NEW_CODES: ReasonCode[] = ['SCHEDULE_WASTE', 'DEVICE_SKEW', 'AUDIENCE_WASTE', 'GROUP_MINUS_GAP']

/** B2B-сценарий: будни конвертят, выходные — слабый спрос. */
function b2bConfig(withSignals: boolean): ScenarioConfig {
  return {
    id: withSignals ? 'DRY_SIGNALS' : 'DRY_CONTROL',
    name: 'Будни — сухой замер device/schedule',
    set: 'tuning',
    days: 21, // 3 недели → ≥2 полных выходных с расходом
    quarantineUntilDay: 0,
    phrases: [
      {
        keywordId: 201,
        adGroupId: 'G1',
        adGroupName: 'G1 Обеды',
        text: 'доставка обедов в офис',
        isCore: true,
        trueCtrByTv: { 15: 0.03, 65: 0.06, 75: 0.07, 85: 0.09, 100: 0.11 },
        trueCr: 0.06,
        demandPerDay: 60,
        startBidMicro: 52_000_000,
      },
      {
        keywordId: 202,
        adGroupId: 'G1',
        adGroupName: 'G1 Обеды',
        text: 'комплексные обеды москва',
        isCore: true,
        trueCtrByTv: { 15: 0.03, 65: 0.06, 75: 0.07, 85: 0.09, 100: 0.11 },
        trueCr: 0.05,
        demandPerDay: 50,
        startBidMicro: 52_000_000,
      },
    ],
    queries: [],
    ads: [{ adId: 301, adGroupId: 'G1', textQuality: 1, rejectedFromDay: null }],
    events: [],
    weekdayDemand: [1, 1, 1, 1, 1, 0.35, 0.35], // выходные жгут бюджет, но спрос слабый
    conversionLagDays: { 0: 1 },
    yclidLossRate: 0.1,
    cpcByTv: { 15: 20, 65: 45, 75: 52, 85: 120, 100: 180 },
    expectations: { causeCodes: {}, anomalies: [], notes: 'сухой замер device/schedule' },
    diagnostics: withSignals
      ? {
          noSchedule: true,
          deviceStats: [
            { device: 'PC', visits: 55, goalReaches: 5, bounceRate: 0.1 },
            { device: 'Smartphones', visits: 35, goalReaches: 0, bounceRate: 0.5 },
          ],
        }
      : undefined,
  }
}

async function measure(config: ScenarioConfig): Promise<Record<ReasonCode, number>> {
  const { result } = await runScenario({
    engine: worldEngine,
    config,
    seed: 7,
    policy: 'boris',
    llmMode: 'stub',
    oracle: computeOracleVerdicts(config),
  })
  const counts = {} as Record<ReasonCode, number>
  for (const code of NEW_CODES) {
    counts[code] = result.decisions.filter((d) => d.reasonCode === code).length
  }
  return counts
}

describe('ШАГ 3 — сухой замер новых диагнозов (сессия «Прозрение»)', () => {
  it(
    'сигналы зажигают DEVICE_SKEW/SCHEDULE_WASTE; без сигналов — молчат',
    async () => {
      const control = await measure(b2bConfig(false))
      const signals = await measure(b2bConfig(true))
      console.log('[dry] control (без сигналов):', JSON.stringify(control))
      console.log('[dry] signals (перекос+нет расписания):', JSON.stringify(signals))

      // Инвариант инертности: без сигналов новые диагнозы молчат → baseline не поехал.
      for (const code of NEW_CODES) expect(control[code]).toBe(0)

      // Диагностика ВЫРОСЛА: DEVICE_SKEW обязан зажечься (инъекция детерминирована),
      // суммарно новых диагнозов больше нуля против нуля в контроле.
      expect(signals.DEVICE_SKEW).toBeGreaterThan(0)
      const grown = NEW_CODES.reduce((a, c) => a + signals[c], 0)
      expect(grown).toBeGreaterThan(0)
    },
    300_000
  )
})
