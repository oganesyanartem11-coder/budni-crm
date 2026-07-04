/**
 * Ядро прогона полигона: для одного (сценарий, зерно) гоняет ВСЕ политики
 * (lazy/random/greedy/oracle/boris) на одном мире-зерне и считает скор каждой.
 *
 * Экономические якоря скорера — прогоны lazy (пол) и oracle (потолок) на ТОМ ЖЕ
 * зерне. Эталоны атрибуции берутся из мира КАЖДОЙ политики (лиды, которые
 * реально случились под её действиями). Для сценариев смены режима oracle-бот
 * адаптируется (pre→post со дня события), а скорер судит по пост-фазному
 * оптимуму (Борис обязан оказаться там же к концу).
 */

import type { WorldEngine } from '../engine/api'
import type { PolicyName, ScenarioConfig, ScenarioScore, WorldEvent } from '../types'
import {
  computeOracleVerdicts,
  computeAttributionReferences,
} from '../oracle/oracle'
import {
  makeLazyBot,
  makeRandomBot,
  makeGreedyBot,
  makeOracleBot,
  type BotPolicy,
} from '../oracle/baselines'
import { scoreRun, type ScoreInput } from '../score/scorer'
import { runScenario, randomBotRng, startBidsOf, type RunOutcome } from './harness'

/** День первого regime_change (или null). Сценарий памяти ⇔ есть regime_change. */
function firstRegimeDay(events: WorldEvent[]): number | null {
  const ev = events.find((e) => e.kind === 'regime_change')
  return ev ? ev.day : null
}

export interface CoreRunOptions {
  llmMode: 'live' | 'stub'
  reportDelayPolls?: number
  /** Реальный callBorisDirectLlm для 'live' (передаётся из simtest через importActual). */
  liveLlmImpl?: RunOutcome extends never ? never : Parameters<typeof runScenario>[0]['liveLlmImpl']
  /** Какие политики гонять (по умолчанию все пять). */
  policies?: PolicyName[]
}

const ALL_POLICIES: PolicyName[] = ['lazy', 'random', 'greedy', 'oracle', 'boris']

/** Собрать бота по имени политики (кроме 'boris' — тот идёт через мозг). */
function botFor(
  policy: PolicyName,
  seed: number,
  config: ScenarioConfig,
  verdictsPre: ReturnType<typeof computeOracleVerdicts>,
  verdictsPost: ReturnType<typeof computeOracleVerdicts> | null,
  switchDay: number | null
): BotPolicy | null {
  switch (policy) {
    case 'lazy':
      return makeLazyBot()
    case 'random':
      return makeRandomBot(randomBotRng(seed))
    case 'greedy':
      return makeGreedyBot()
    case 'oracle':
      return makeOracleBot(verdictsPre, verdictsPost, switchDay)
    default:
      return null
  }
}

export interface ScenarioRunResult {
  scores: ScenarioScore[]
  /** Экономика по политикам (заявки на рубль) — для отчёта капчура. */
  economics: Record<PolicyName, { leadsPerRub: number; leads: number; spendRub: number }>
}

export async function runAndScoreScenario(
  engine: WorldEngine,
  config: ScenarioConfig,
  seed: number,
  opts: CoreRunOptions
): Promise<ScenarioRunResult> {
  const regimeDay = firstRegimeDay(config.events)
  const memoryScenario = regimeDay !== null

  // Вердикты оракула: для сценариев памяти скорим по пост-фазе (финал важен);
  // oracle-бот адаптируется pre→post со дня события.
  const verdictsPre = computeOracleVerdicts(config, { phase: memoryScenario ? 'pre' : 'blend' })
  const verdictsPost = memoryScenario ? computeOracleVerdicts(config, { phase: 'post' }) : null
  const scoringOracle = memoryScenario ? (verdictsPost ?? verdictsPre) : verdictsPre
  const switchDay = memoryScenario ? regimeDay : null

  const policies = opts.policies ?? ALL_POLICIES

  // 1. Прогнать нужные политики (lazy/oracle нужны ВСЕГДА как якоря экономики).
  const needed = new Set<PolicyName>([...policies, 'lazy', 'oracle'])
  const outcomes = new Map<PolicyName, RunOutcome>()
  for (const policy of ['lazy', 'oracle', 'greedy', 'random', 'boris'] as PolicyName[]) {
    if (!needed.has(policy)) continue
    const bot = botFor(policy, seed, config, verdictsPre, verdictsPost, switchDay)
    const outcome = await runScenario({
      engine,
      config,
      seed,
      policy,
      llmMode: opts.llmMode,
      reportDelayPolls: opts.reportDelayPolls,
      oracle: policy === 'boris' ? scoringOracle : undefined,
      bot: bot ?? undefined,
      liveLlmImpl: opts.liveLlmImpl,
    })
    outcomes.set(policy, outcome)
  }

  const lazyOut = outcomes.get('lazy')!
  const oracleOut = outcomes.get('oracle')!

  // 2. Скорить каждую запрошенную политику.
  const scores: ScenarioScore[] = []
  for (const policy of policies) {
    const out = outcomes.get(policy)
    if (!out) continue
    const refs = computeAttributionReferences(out.world)
    const input: ScoreInput = {
      run: out.result,
      oracle: scoringOracle,
      lazyRun: lazyOut.result,
      oracleRun: oracleOut.result,
      attributionRefs: { omniscient: refs.omniscient, inferable: refs.inferable },
      borisAttribution: policy === 'boris' ? out.borisAttribution : undefined,
      quarantineUntilDay: config.quarantineUntilDay,
      expectedAnomalies: config.expectations.anomalies,
      memoryScenario,
      negativesMatch: engine.negativesMatch,
      startBids: startBidsOf(config),
      cpcByTv: config.cpcByTv,
      regimeDay: regimeDay ?? undefined,
    }
    scores.push(scoreRun(input))
  }

  // 3. Экономика по политикам (для капчур-отчёта).
  const economics = {} as Record<PolicyName, { leadsPerRub: number; leads: number; spendRub: number }>
  for (const policy of policies) {
    const out = outcomes.get(policy)
    if (!out) continue
    const { leads, spendRub } = out.result
    economics[policy] = { leadsPerRub: leads / Math.max(spendRub, 1), leads, spendRub }
  }

  return { scores, economics }
}
