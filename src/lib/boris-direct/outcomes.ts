/**
 * Исходы действий и предложений Бориса-Директа (память-опыт): измерение
 * «до/после» по BorisDirectQueryDailyStat и вердикты improved/neutral/
 * worse/unmeasurable в outcome*-поля ActionLog/Proposal.
 *
 * ВСЯ арифметика — код, без LLM. Пороги — ТОЛЬКО из config.
 * Мало данных (клики < OUTCOME_MIN_CLICKS в любом окне, цена заявки не
 * определена) → честный 'unmeasurable', выводы не притягиваем.
 *
 * generateCorrectionProposals: по исходам 'worse' создаёт предложения
 * коррекции (откат ставок / пересмотр минус-пакета) — РАБОТАЕТ ТОЛЬКО при
 * isAutoCorrectionEnabled() (выключено по умолчанию), иначе no-op.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  OUTCOME_IMPROVED_RATIO,
  OUTCOME_MIN_CLICKS,
  OUTCOME_WINDOW_DAYS,
  OUTCOME_WORSE_RATIO,
  isAutoCorrectionEnabled,
} from './config'
import { createProposal, type ProposalInput } from './proposals'

const DAY_MS = 24 * 60 * 60 * 1000

export interface OutcomeMeasureResult {
  measured: number
  worse: number
  unmeasurable: number
}

export type OutcomeVerdict = 'improved' | 'neutral' | 'worse' | 'unmeasurable'

/** Агрегат окна: клики, расход, конверсии и цена заявки (null = заявок нет). */
interface WindowStats {
  clicks: number
  costRub: number
  conversions: number
  cpl: number | null
}

/** Содержимое outcomeData: окна «до»/«после» и ratio (null = не считался). */
interface OutcomeData {
  before: WindowStats
  after: WindowStats
  ratio: number | null
}

interface OutcomeComputation {
  verdict: OutcomeVerdict
  data: OutcomeData
}

// ---------- Агрегация окон ----------

/** Суммы по BorisDirectQueryDailyStat за [from, to); adGroupId — опциональный фильтр. */
async function loadWindowStats(from: Date, to: Date, adGroupId?: string): Promise<WindowStats> {
  const rows = await prisma.borisDirectQueryDailyStat.findMany({
    where: { date: { gte: from, lt: to }, ...(adGroupId ? { adGroupId } : {}) },
    select: { clicks: true, costRub: true, conversions: true },
  })
  let clicks = 0
  let costRub = 0
  let conversions = 0
  for (const row of rows) {
    clicks += row.clicks
    costRub += Number(row.costRub) // Decimal → number
    conversions += row.conversions
  }
  return { clicks, costRub, conversions, cpl: conversions > 0 ? costRub / conversions : null }
}

/** Вердикт по окнам «до»/«после». Порядок проверок: шум → провал заявок → ratio. */
function computeVerdict(before: WindowStats, after: WindowStats): OutcomeComputation {
  // Мало кликов в любом окне — данных недостаточно, вывод не притягиваем.
  if (before.clicks < OUTCOME_MIN_CLICKS || after.clicks < OUTCOME_MIN_CLICKS) {
    return { verdict: 'unmeasurable', data: { before, after, ratio: null } }
  }
  // Расход есть, а заявок после — ноль: провал, если до действия заявки были.
  if (after.conversions === 0 && after.costRub > 0) {
    return {
      verdict: before.conversions > 0 ? 'worse' : 'unmeasurable',
      data: { before, after, ratio: null },
    }
  }
  // Цена заявки не определена в одном из окон — честно «не измерить».
  if (before.cpl === null || after.cpl === null) {
    return { verdict: 'unmeasurable', data: { before, after, ratio: null } }
  }
  const ratio = after.cpl / before.cpl
  const verdict: OutcomeVerdict =
    ratio >= OUTCOME_WORSE_RATIO
      ? 'worse'
      : ratio <= OUTCOME_IMPROVED_RATIO
        ? 'improved'
        : 'neutral'
  return { verdict, data: { before, after, ratio } }
}

/** Окна вокруг точки отсчёта: ДО = [anchor−W, anchor), ПОСЛЕ = [anchor, anchor+W). */
async function measureAround(anchor: Date, adGroupId?: string): Promise<OutcomeComputation> {
  const windowMs = OUTCOME_WINDOW_DAYS * DAY_MS
  const before = await loadWindowStats(new Date(anchor.getTime() - windowMs), anchor, adGroupId)
  const after = await loadWindowStats(anchor, new Date(anchor.getTime() + windowMs), adGroupId)
  return computeVerdict(before, after)
}

function tally(result: OutcomeMeasureResult, verdict: OutcomeVerdict): void {
  result.measured += 1
  if (verdict === 'worse') result.worse += 1
  if (verdict === 'unmeasurable') result.unmeasurable += 1
}

// ---------- Измерение исходов действий ----------

/**
 * Действия с applied=true без исхода, созревшие (createdAt старше
 * OUTCOME_WINDOW_DAYS): меряем «до/после» и пишем вердикт в лог.
 * Действие по конкретной группе (targetType 'adgroup') меряем по её срезу,
 * остальное — по всей кампании. Ошибка одной записи не роняет остальные.
 */
export async function measureActionOutcomes(now: Date = new Date()): Promise<OutcomeMeasureResult> {
  const cutoff = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS)
  const logs = await prisma.borisDirectActionLog.findMany({
    where: { applied: true, outcomeMeasuredAt: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
  })

  const result: OutcomeMeasureResult = { measured: 0, worse: 0, unmeasurable: 0 }
  for (const log of logs) {
    try {
      const adGroupId =
        log.targetType === 'adgroup' && log.targetId ? log.targetId : undefined
      const outcome = await measureAround(log.createdAt, adGroupId)
      await prisma.borisDirectActionLog.update({
        where: { id: log.id },
        data: {
          outcomeVerdict: outcome.verdict,
          outcomeMeasuredAt: now,
          outcomeData: outcome.data as unknown as Prisma.InputJsonValue,
        },
      })
      tally(result, outcome.verdict)
    } catch (err) {
      console.error(`[boris-direct/outcomes] исход действия ${log.id} не измерен:`, err)
    }
  }
  return result
}

// ---------- Измерение исходов предложений ----------

/** payload.applied === true — предложение реально применено мозгом (см. proposals.ts). */
function isAppliedPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).applied === true
  )
}

/**
 * То же для принятых И применённых предложений (status ACCEPTED,
 * payload.applied===true). Точка отсчёта — decidedAt (null → пропустить),
 * срез — вся кампания.
 */
export async function measureProposalOutcomes(
  now: Date = new Date()
): Promise<OutcomeMeasureResult> {
  const cutoff = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS)
  const proposals = await prisma.borisDirectProposal.findMany({
    where: { status: 'ACCEPTED', outcomeMeasuredAt: null },
    orderBy: { decidedAt: 'asc' },
  })

  const result: OutcomeMeasureResult = { measured: 0, worse: 0, unmeasurable: 0 }
  for (const proposal of proposals) {
    try {
      if (!proposal.decidedAt) continue // решения нет — мерить не от чего
      if (proposal.decidedAt.getTime() >= cutoff.getTime()) continue // окно «после» не дозрело
      if (!isAppliedPayload(proposal.payload)) continue // принято, но ещё не применено
      const outcome = await measureAround(proposal.decidedAt)
      await prisma.borisDirectProposal.update({
        where: { id: proposal.id },
        data: {
          outcomeVerdict: outcome.verdict,
          outcomeMeasuredAt: now,
          outcomeData: outcome.data as unknown as Prisma.InputJsonValue,
        },
      })
      tally(result, outcome.verdict)
    } catch (err) {
      console.error(`[boris-direct/outcomes] исход предложения ${proposal.id} не измерен:`, err)
    }
  }
  return result
}

// ---------- Авто-предложения коррекции (за флагом владельца) ----------

interface ParsedWindow {
  clicks: number | null
  costRub: number | null
  conversions: number | null
  cpl: number | null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseWindow(value: unknown): ParsedWindow {
  const r = asRecord(value)
  return {
    clicks: asNumber(r.clicks),
    costRub: asNumber(r.costRub),
    conversions: asNumber(r.conversions),
    cpl: asNumber(r.cpl),
  }
}

/** Безопасное чтение outcomeData из JSON (структуру писали мы же, но не доверяем). */
function parseOutcomeData(raw: unknown): {
  before: ParsedWindow
  after: ParsedWindow
  ratio: number | null
} {
  const root = asRecord(raw)
  return {
    before: parseWindow(root.before),
    after: parseWindow(root.after),
    ratio: asNumber(root.ratio),
  }
}

const fmtRub = (value: number): string => String(Math.round(value))

/** Детерминированный аргумент с цифрами до/после из outcomeData (без LLM). */
function formatWorseArgument(outcomeData: unknown): string {
  const { before, after, ratio } = parseOutcomeData(outcomeData)
  if (after.cpl === null) {
    const spent = after.costRub === null ? '?' : fmtRub(after.costRub)
    const was = before.cpl === null ? 'не считалась' : `${fmtRub(before.cpl)} ₽`
    return (
      `Исход хуже: за ${OUTCOME_WINDOW_DAYS} дн. после действия заявок нет ` +
      `(расход ${spent} ₽), до действия цена заявки была ${was}.`
    )
  }
  const was = before.cpl === null ? '?' : fmtRub(before.cpl)
  const grew = ratio === null ? '' : ` (×${ratio.toFixed(2)})`
  return (
    `Исход хуже: цена заявки ${was} ₽ → ${fmtRub(after.cpl)} ₽${grew} ` +
    `за ${OUTCOME_WINDOW_DAYS} дн. до/после действия.`
  )
}

/** Предложение коррекции по плохому исходу; неизвестные действия пропускаем. */
function buildCorrectionInput(log: {
  id: string
  action: string
  outcomeData: unknown
}): ProposalInput | null {
  if (log.action === 'keywordbids.set') {
    return {
      type: 'bid_revert',
      topicKey: `bid_revert_${log.id}`,
      payload: { actionLogId: log.id },
      argument: formatWorseArgument(log.outcomeData),
      question: 'Откатить ставки к прежним?',
    }
  }
  if (log.action === 'campaigns.update.negatives') {
    return {
      type: 'minus_review',
      topicKey: `minus_review_${log.id}`,
      payload: { actionLogId: log.id },
      argument: formatWorseArgument(log.outcomeData),
      question: 'Пересмотреть этот минус-пакет?',
    }
  }
  return null
}

/**
 * По свежим (2×OUTCOME_WINDOW_DAYS) неоткаченным действиям с исходом 'worse'
 * предложить владельцу коррекцию. ТОЛЬКО при isAutoCorrectionEnabled() —
 * по умолчанию выключено, тогда no-op. Дедуп/cooldown делает createProposal.
 */
export async function generateCorrectionProposals(
  now: Date = new Date()
): Promise<{ created: number }> {
  if (!isAutoCorrectionEnabled()) return { created: 0 }

  const since = new Date(now.getTime() - 2 * OUTCOME_WINDOW_DAYS * DAY_MS)
  const logs = await prisma.borisDirectActionLog.findMany({
    where: { outcomeVerdict: 'worse', revertedAt: null, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
  })

  let created = 0
  for (const log of logs) {
    try {
      const input = buildCorrectionInput(log)
      if (!input) continue
      const res = await createProposal(input)
      if (res.created) created += 1
    } catch (err) {
      console.error(`[boris-direct/outcomes] коррекция по действию ${log.id} не создана:`, err)
    }
  }
  return { created }
}
