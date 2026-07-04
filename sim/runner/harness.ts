/**
 * Харнесс полигона: гоняет ОДНУ политику (Борис или бот) на одном
 * (сценарий, зерно) через симулированный мир и собирает RunResult.
 *
 * Для Бориса каждый виртуальный день повторяет боевой суточный цикл кронов
 * boris-direct-collect и boris-direct-process (последовательности взяты из
 * самих роутов), плюс владелец-бот отвечает на предложения. Мозг — РЕАЛЬНЫЙ
 * (мок только на листовом транспорте, см. mocks.setup.ts); режим LIVE, чтобы
 * действия реально применялись к миру и проверялись последствия. Предохранители
 * (потолок 400 ₽, circuit breaker, гейт suspend) остаются в write-gate и
 * работают по-настоящему.
 *
 * Виртуальные часы: vi.setSystemTime(dayToDate(day)) на каждый день — так
 * `new Date()` внутри proposals/learning/outcomes идёт по виртуальному
 * времени, а не по реальным часам машины.
 */

import { vi } from 'vitest'
import type { WorldEngine } from '../engine/api'
import { mulberry32 } from '../engine/rng'
import type {
  CapturedAction,
  CapturedProposal,
  DecisionRecord,
  OracleVerdicts,
  PolicyName,
  RunResult,
  ScenarioConfig,
} from '../types'
import { leadKey } from '../types'
import type { BotPolicy } from '../oracle/baselines'
import {
  SimContext,
  simContext,
  dayToDate,
  dayToMskString,
  mskStringToDay,
} from '../fakes/context'
import { setLiveLlmImpl } from '../fakes/llm'
import { runOwnerBot } from './owner-bot'

// Реальные модули мозга (их транспорт замокан в mocks.setup.ts).
import { runCollectTick, runProcessTick, mskDayStartUtc } from '@/lib/boris-direct/brain'
import {
  createProposal,
  expireStaleProposals,
  decideProposal,
  formatProposalSummary,
} from '@/lib/boris-direct/proposals'
import {
  recordVerdicts,
  getLearningStats,
  shouldOfferGateLift,
  buildGateLiftProposalInput,
} from '@/lib/boris-direct/learning'
import { applyAcceptedProposals } from '@/lib/boris-direct/apply-accepted'
import { getDirectRoleState, setDirectMode } from '@/lib/boris-direct/state'
import { suspendCampaignEmergency } from '@/lib/boris-direct/write-gate'
import { formatAnomalyMessage } from '@/lib/boris-direct/report-texts'
import { prisma } from '@/lib/db/prisma'

export interface RunScenarioOpts {
  engine: WorldEngine
  config: ScenarioConfig
  seed: number
  policy: PolicyName
  llmMode: 'live' | 'stub'
  reportDelayPolls?: number
  /** Для Бориса: правда мира — владелец-бот решает предложения по ней. */
  oracle?: OracleVerdicts
  /** Для бота-политики: фабрика уже построенного бота (lazy/random/greedy/oracle). */
  bot?: BotPolicy
  /** Для 'live'-режима LLM: реальная реализация callBorisDirectLlm (vi.importActual). */
  liveLlmImpl?: Parameters<typeof setLiveLlmImpl>[0]
}

/** Персист дневных лидов в фейк-присму — имитация /api/leads/intake. */
async function persistDayLeads(
  leads: Array<{ phoneDigits: string; yclid: string | null; utmCampaign: string | null; utmTerm: string | null }>,
  day: number
): Promise<void> {
  for (const lead of leads) {
    await prisma.landingLead.create({
      data: {
        formType: 'popup',
        name: null,
        phone: lead.phoneDigits,
        phoneDigits: lead.phoneDigits,
        source: 'sim',
        utmSource: 'yandex-direct',
        utmMedium: 'cpc',
        utmCampaign: lead.utmCampaign,
        utmContent: null,
        utmTerm: lead.utmTerm,
        yclid: lead.yclid,
        gclid: null,
        pageUrl: null,
        pageReferrer: null,
        answers: undefined,
        meta: undefined,
        createdAt: dayToDate(day),
      },
    })
  }
}

/** Точность вердиктов Бориса по спорным минусам против правды (для gate-lift). */
function makeMinusVerdictAccuracy(oracle: OracleVerdicts, engine: WorldEngine) {
  return async (): Promise<number> => {
    const rows = (await prisma.borisDirectMinusVerdict.findMany({})) as Array<{
      candidate: string
      verdict: string
    }>
    if (rows.length === 0) return 0
    let matched = 0
    for (const r of rows) {
      const trulyTrash = [...oracle.mustMinus].some((q) => engine.negativesMatch([r.candidate], q))
      const shouldMinus = trulyTrash
      const said = r.verdict === 'minus'
      if (said === shouldMinus) matched++
    }
    return matched / rows.length
  }
}

/** Один суточный цикл Бориса: collect → process → владелец решает. */
async function borisDay(
  day: number,
  ctx: SimContext,
  engine: WorldEngine,
  oracle: OracleVerdicts,
  accum: {
    decisions: DecisionRecord[]
    proposals: CapturedProposal[]
    attribution: Array<{ leadKey: string; adGroupId: string | null; query: string | null; matchedBy: string }>
    minusAcc: () => Promise<number>
  }
): Promise<void> {
  const now = dayToDate(day)

  // --- COLLECT (см. boris-direct-collect route) ---
  const collect = await runCollectTick(now)
  for (const anomaly of collect.anomalies) {
    ctx.alerts.push({ day, kind: anomaly.kind, text: formatAnomalyMessage(anomaly) })
  }
  if (collect.catastrophe) {
    await suspendCampaignEmergency('катастрофа: неуправляемый расход')
    ctx.alerts.push({ day, kind: 'catastrophe', text: '🚨 КАТАСТРОФА: аварийная остановка' })
  }

  // --- PROCESS (см. boris-direct-process route) ---
  const result = await runProcessTick(now)
  if (result.decisions) accum.decisions.push(...result.decisions)
  if (result.attribution) accum.attribution.push(...result.attribution)

  if (result.status === 'waiting_report') return // отчёт не дозрел — следующий день дожмёт

  // Предложения владельцу (до вердиктов — нужна связка verdicts↔proposal).
  let minusProposalId: string | null = null
  for (const draft of result.proposalDrafts) {
    try {
      const created = await createProposal(draft)
      if (!created.created) continue
      if (draft.type === 'minus_words') {
        const row = (await prisma.borisDirectProposal.findFirst({
          where: { topicKey: draft.topicKey, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })) as { id: string } | null
        minusProposalId = row?.id ?? null
      }
      // formatProposalSummary — только чтобы упражнять реальный путь (имя не храним).
      formatProposalSummary(draft.type, draft.payload)
    } catch {
      /* создание предложения не роняет день */
    }
  }

  if (result.verdicts.length > 0) {
    try {
      await recordVerdicts(result.verdicts, minusProposalId)
    } catch {
      /* запись вердиктов не роняет день */
    }
  }

  // Снапшот дневного результата (из него формируется дневной отчёт).
  if (result.reportData) {
    try {
      await prisma.borisDirectSnapshot.create({
        data: {
          tickDate: mskDayStartUtc(result.reportData.dateLabel),
          kind: 'daily_result',
          payload: JSON.parse(
            JSON.stringify({
              ...result.reportData,
              appliedSummaries: result.appliedSummaries,
              wouldDoSummaries: result.wouldDoSummaries,
            })
          ),
        },
      })
    } catch {
      /* снапшот не роняет день */
    }
  }

  // Принятые владельцем ранее предложения → применение к миру.
  try {
    await applyAcceptedProposals()
  } catch {
    /* применение не роняет день */
  }

  try {
    await expireStaleProposals()
  } catch {
    /* протухание не роняет день */
  }

  // Обучение созрело и гейт ещё стоит → предложить снять.
  try {
    const stats = await getLearningStats()
    const state = await getDirectRoleState()
    if (shouldOfferGateLift(stats) && state.autoNegativesEnabled === false) {
      await createProposal(buildGateLiftProposalInput(stats))
    }
  } catch {
    /* оффер гейта не роняет день */
  }

  // Аномалии тика — владельцу немедленно.
  for (const anomaly of result.anomalies) {
    ctx.alerts.push({ day, kind: anomaly.kind, text: formatAnomalyMessage(anomaly) })
  }

  // Владелец-бот отвечает на все PENDING-предложения (по правде мира).
  const decided = await runOwnerBot(day, {
    listPending: async () =>
      (await prisma.borisDirectProposal.findMany({
        where: { status: 'PENDING' },
      })) as Array<{ id: string; type: string; topicKey: string; payload: unknown; status: string }>,
    decide: decideProposal,
    negativesMatch: engine.negativesMatch,
    oracle,
    minusVerdictAccuracy: () => accum.minusAcc(),
  })
  accum.proposals.push(...decided)
}

export interface RunOutcome {
  result: RunResult
  /** Финальный мир прогона — из него скорер строит эталоны атрибуции. */
  world: import('../types').WorldState
  /** Атрибуция, которую эмитировал Борис (нормализованная под ключи оракула). */
  borisAttribution: Array<{
    leadKey: string
    adGroupId: string | null
    query: string | null
    matchedBy: string
  }>
}

/**
 * Запустить прогон одной политики. Возвращает RunResult + финальный мир.
 * simContext.current устанавливается на время прогона и снимается после.
 */
export async function runScenario(opts: RunScenarioOpts): Promise<RunOutcome> {
  const { engine, config, seed, policy } = opts
  const world = engine.createWorld(config, seed)
  const ctx = new SimContext({
    engine,
    world,
    policy,
    llmMode: opts.llmMode,
    reportDelayPolls: opts.reportDelayPolls ?? 0,
  })
  simContext.current = ctx

  if (opts.llmMode === 'live') setLiveLlmImpl(opts.liveLlmImpl ?? null)

  const decisions: DecisionRecord[] = []
  const proposals: CapturedProposal[] = []
  const attribution: Array<{ leadKey: string; adGroupId: string | null; query: string | null; matchedBy: string }> = []
  const reliability = { crashed: false, crashNote: undefined as string | undefined, silentOnBrokenData: false }
  let sawBrokenData = false

  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    if (policy === 'boris') {
      // Боевой режим против фейкового Директа: иначе тестировали бы только
      // «сделал бы». Ставим строку состояния в ФЕЙК-БД прогона (прод-дефолт
      // observe в коде не меняется).
      vi.setSystemTime(dayToDate(0))
      ctx.clockDay = 0
      await setDirectMode('LIVE')

      const oracle = opts.oracle
      if (!oracle) throw new Error('runScenario(boris): нужен oracle для владельца-бота')
      const accum = {
        decisions,
        proposals,
        attribution,
        minusAcc: makeMinusVerdictAccuracy(oracle, engine),
      }

      for (let day = 0; day < config.days; day++) {
        vi.setSystemTime(dayToDate(day))
        ctx.clockDay = day
        const dayObs = engine.advanceDay(world)
        ctx.days.push(dayObs)
        if (dayObs.addMetricaTag === 'NO') sawBrokenData = true
        await persistDayLeads(dayObs.newLeads, day)
        try {
          await borisDay(day, ctx, engine, oracle, accum)
        } catch (err) {
          reliability.crashed = true
          reliability.crashNote = err instanceof Error ? err.message : String(err)
          break
        }
      }
    } else {
      // Бот-политика: без мозга, действует напрямую через движок.
      const bot = opts.bot
      if (!bot) throw new Error(`runScenario(${policy}): нужен bot`)
      for (let day = 0; day < config.days; day++) {
        vi.setSystemTime(dayToDate(day))
        ctx.clockDay = day
        const dayObs = engine.advanceDay(world)
        ctx.days.push(dayObs)
        if (dayObs.addMetricaTag === 'NO') sawBrokenData = true
        bot.onDayEnd(world, engine, dayObs, ctx.captured)
      }
    }
  } finally {
    vi.useRealTimers()
    simContext.current = null
  }

  // Ворота надёжности: были битые данные (слетел тег), но Борис ни разу не
  // просигналил — молчаливое решение на битых данных.
  if (sawBrokenData) {
    const flagged = ctx.alerts.some((a) =>
      /метрик|размет|тег|metrica|mismatch|расхожд|DATA_MISMATCH/i.test(`${a.kind} ${a.text}`)
    )
    reliability.silentOnBrokenData = !flagged
  }

  const totals = engine.getTotals(world)
  const result: RunResult = {
    scenarioId: config.id,
    set: config.set,
    seed,
    policy,
    days: config.days,
    spendRub: totals.spendRub,
    leads: totals.trueLeads,
    leadsObserved: totals.observedLeads,
    actions: ctx.captured.slice(),
    decisions,
    proposals,
    alerts: ctx.alerts.slice(),
    reliability,
  }
  return { result, world, borisAttribution: normalizeBorisAttribution(attribution) }
}

/** RNG для случайного бота, детерминированно от зерна прогона. */
export function randomBotRng(seed: number): () => number {
  return mulberry32(seed ^ 0x9e3779b9)
}

/** Ключ атрибуции Бориса → канонический (номер дня), чтобы бился с оракулом. */
export function normalizeBorisAttribution(
  attribution: Array<{ leadKey: string; adGroupId: string | null; query: string | null; matchedBy: string }>
): Array<{ leadKey: string; adGroupId: string | null; query: string | null; matchedBy: string }> {
  return attribution.map((a) => {
    const at = a.leadKey.lastIndexOf('@')
    if (at < 0) return a
    const phone = a.leadKey.slice(0, at)
    const datePart = a.leadKey.slice(at + 1)
    // datePart вида 'YYYY-MM-DD' → номер виртуального дня.
    const dayNum = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? mskStringToDay(datePart) : NaN
    if (Number.isNaN(dayNum)) return a
    return { ...a, leadKey: leadKey(phone, dayNum) }
  })
}

/** Стартовые ставки фраз (для скорера — в RunResult их нет). */
export function startBidsOf(config: ScenarioConfig): Map<number, number> {
  const m = new Map<number, number>()
  for (const p of config.phrases) m.set(p.keywordId, p.startBidMicro)
  return m
}

export { dayToMskString }
