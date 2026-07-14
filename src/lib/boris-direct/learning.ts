/**
 * Обучение минусовки (BorisDirectMinusVerdict): каждый спорный кандидат
 * логируется с вердиктом Бориса ('minus'|'keep'); решение владельца по
 * предложению проставляет ownerDecision и matched (совпал ли вердикт).
 *
 * По окну LEARNING_WINDOW считаем matchRate и streak (подряд с самой свежей);
 * при streak ≥ LEARNING_GATE_STREAK и matchRate ≥ LEARNING_GATE_ACCURACY
 * Борис сам предлагает снять гейт (buildGateLiftProposalInput → proposals).
 */

import { prisma } from '@/lib/db/prisma'
import {
  LEARNING_WINDOW,
  LEARNING_GATE_STREAK,
  LEARNING_GATE_ACCURACY,
} from './config'
import type { ProposalInput } from './proposals'

export interface VerdictDraft {
  candidate: string
  verdict: 'minus' | 'keep'
  reason: string
}

export interface LearningStats {
  decided: number
  matchRate: number | null
  streak: number
}

/** Залогировать вердикты Бориса по спорным кандидатам (до решения владельца). */
export async function recordVerdicts(
  drafts: VerdictDraft[],
  proposalId: string | null
): Promise<void> {
  if (drafts.length === 0) return
  await prisma.borisDirectMinusVerdict.createMany({
    data: drafts.map((d) => ({
      candidate: d.candidate,
      verdict: d.verdict,
      reason: d.reason,
      proposalId,
      // matched НЕ ставим в false преждевременно: совпадение с решением владельца
      // неизвестно, пока он не решил (ownerDecision=null). Явный null — чтобы никакой
      // дефолт/сериализация не превратили «не решено» в «не совпал» (аудит 14.07:
      // строка с matched=false при ownerDecision=null читалась как ошибка Бориса).
      matched: null,
    })),
  })
}

/**
 * Решение владельца по предложению минусовки.
 *
 * matched зависит от вердикта КАЖДОЙ записи: (verdict==='minus') === approved.
 * Одним updateMany не выразить → два прохода:
 *  - verdict 'minus' → matched = approved (владелец принял минусовку — Борис прав);
 *  - verdict 'keep'  → matched = !approved.
 */
export async function recordOwnerDecision(
  proposalId: string,
  approved: boolean
): Promise<void> {
  const now = new Date()
  const ownerDecision = approved ? 'approved' : 'rejected'
  await prisma.borisDirectMinusVerdict.updateMany({
    where: { proposalId, verdict: 'minus' },
    data: { ownerDecision, matched: approved, decidedAt: now },
  })
  await prisma.borisDirectMinusVerdict.updateMany({
    where: { proposalId, verdict: 'keep' },
    data: { ownerDecision, matched: !approved, decidedAt: now },
  })
}

/**
 * Статистика по последним LEARNING_WINDOW решённым записям (decidedAt desc):
 * matchRate — доля matched===true (null, если решённых нет);
 * streak — подряд matched===true, начиная с самой свежей.
 */
export async function getLearningStats(now: Date = new Date()): Promise<LearningStats> {
  const rows = await prisma.borisDirectMinusVerdict.findMany({
    where: { decidedAt: { not: null, lte: now } },
    orderBy: { decidedAt: 'desc' },
    take: LEARNING_WINDOW,
  })
  const decided = rows.length
  if (decided === 0) return { decided: 0, matchRate: null, streak: 0 }

  const matchedCount = rows.filter((r) => r.matched === true).length
  let streak = 0
  for (const row of rows) {
    if (row.matched !== true) break
    streak += 1
  }
  return { decided, matchRate: matchedCount / decided, streak }
}

export interface OwnerMinusDecision {
  candidate: string
  /** Истина владельца: счёл ли он фразу мусором (минус). */
  ownerSaysTrash: boolean
}

/**
 * ШАГ 3: последние N решённых спорных минусов — истина ВЛАДЕЛЬЦА по фразе (для
 * секции ОПЫТ классификатора). Истина = вердикт Бориса, если matched; иначе
 * обратный (владелец не согласился). Дедуп по фразе — свежее решение побеждает.
 */
export async function getRecentOwnerMinusDecisions(
  limit = 20,
  now: Date = new Date()
): Promise<OwnerMinusDecision[]> {
  const rows = await prisma.borisDirectMinusVerdict.findMany({
    where: { decidedAt: { not: null, lte: now } },
    orderBy: { decidedAt: 'desc' },
    take: limit,
  })
  const seen = new Set<string>()
  const out: OwnerMinusDecision[] = []
  for (const row of rows) {
    if (seen.has(row.candidate)) continue // одна фраза — только свежее решение
    seen.add(row.candidate)
    const ownerVerdict = row.matched === true ? row.verdict : row.verdict === 'minus' ? 'keep' : 'minus'
    out.push({ candidate: row.candidate, ownerSaysTrash: ownerVerdict === 'minus' })
  }
  return out
}

/** Пора ли предлагать снять гейт спорных минусов. */
export function shouldOfferGateLift(stats: LearningStats): boolean {
  return (
    stats.streak >= LEARNING_GATE_STREAK &&
    (stats.matchRate ?? 0) >= LEARNING_GATE_ACCURACY
  )
}

/** Заготовка предложения «снять гейт» для proposals.createProposal. */
export function buildGateLiftProposalInput(stats: LearningStats): ProposalInput {
  const pct = Math.round((stats.matchRate ?? 0) * 100)
  return {
    type: 'lift_minus_gate',
    topicKey: 'lift_minus_gate',
    payload: {
      streak: stats.streak,
      matchRate: stats.matchRate,
      window: LEARNING_WINDOW,
    },
    argument:
      `На последних ${stats.streak} спорных разборах мои вердикты совпали с твоими решениями ` +
      `(${pct}% совпадений на окне ${LEARNING_WINDOW}). Столько подряд не ошибаюсь.`,
    question:
      'Снять гейт и отдать спорные минусы мне в автономию? Вернуть можно командой "Борис, верни гейт".',
  }
}
