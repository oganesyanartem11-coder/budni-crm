/**
 * Владелец-бот полигона: имитирует ответы владельца на предложения Бориса
 * (кнопки да/нет в чате Директа). Решает ПО ПРАВДЕ мира (oracle), чтобы
 * скорер мог судить точность предложений и работу гейта обучения.
 *
 * Вызывается в конце каждого дня прогона Бориса: читает PENDING-предложения
 * из фейк-присмы и по каждому зовёт РЕАЛЬНЫЙ decideProposal(id, action) —
 * так упражняются связка verdicts↔proposal, cooldown после отказа,
 * применение принятого (applyAcceptedProposals следующего тика) и снятие
 * гейта спорных минусов.
 */

import type { OracleVerdicts, CapturedProposal } from '../types'

/** Минимальная форма предложения, которую читаем из фейк-присмы. */
interface PendingProposalRow {
  id: string
  type: string
  topicKey: string
  payload: unknown
  status: string
}

export interface OwnerBotDeps {
  /** Читатель PENDING-предложений (обычно ctx.fakePrisma.borisDirectProposal.findMany). */
  listPending: () => Promise<PendingProposalRow[]>
  /** Реальный decideProposal мозга (через мок-присму пишет в фейк). */
  decide: (id: string, action: 'accept' | 'reject') => Promise<{ ok: boolean; summaryText: string }>
  /** Семантика минусов движка (совпадение фразы с запросом). */
  negativesMatch: (negatives: string[], query: string) => boolean
  oracle: OracleVerdicts
  /** Доля вердиктов Бориса по спорным минусам, совпавших с правдой (для gate-lift). */
  minusVerdictAccuracy: () => Promise<number>
}

function asPhrases(payload: unknown): string[] {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = (payload as Record<string, unknown>).phrases
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  }
  return []
}

/**
 * Верна ли минус-фраза по правде: режет хотя бы один истинно-мусорный запрос
 * (mustMinus) и НЕ режет ни одного живого (mustKeep). Живой трафик под нож —
 * дороже, чем пропущенный мусор, поэтому любое пересечение с mustKeep = «нет».
 */
function isGoodMinusPhrase(
  phrase: string,
  oracle: OracleVerdicts,
  negativesMatch: (negatives: string[], query: string) => boolean
): boolean {
  const hitsTrash = [...oracle.mustMinus].some((q) => negativesMatch([phrase], q))
  const hitsLive = [...oracle.mustKeep].some((q) => negativesMatch([phrase], q))
  return hitsTrash && !hitsLive
}

/** Порог «большинство фраз хороши» для принятия minus_words. */
const MINUS_ACCEPT_RATIO = 0.6
/** Порог истинной точности вердиктов для законности снятия гейта. */
const GATE_LIFT_TRUE_ACCURACY = 0.9

export async function runOwnerBot(day: number, deps: OwnerBotDeps): Promise<CapturedProposal[]> {
  const pending = await deps.listPending()
  const decided: CapturedProposal[] = []

  for (const proposal of pending) {
    let action: 'accept' | 'reject'
    let wasCorrect: boolean

    if (proposal.type === 'minus_words') {
      const phrases = asPhrases(proposal.payload)
      const good = phrases.filter((p) => isGoodMinusPhrase(p, deps.oracle, deps.negativesMatch))
      const ratio = phrases.length > 0 ? good.length / phrases.length : 0
      // Принять пакет минусов, только если большинство фраз реально мусор и
      // ни одна не бьёт по живому. Иначе отказ (→ cooldown 14 дн).
      const noneHitLive = good.length === phrases.length
      action = ratio >= MINUS_ACCEPT_RATIO && noneHitLive ? 'accept' : 'reject'
      wasCorrect = action === 'accept'
    } else if (proposal.type === 'lift_minus_gate') {
      // Снять гейт спорных минусов — только если Борис реально почти не ошибался.
      const trulyAccurate = (await deps.minusVerdictAccuracy()) >= GATE_LIFT_TRUE_ACCURACY
      action = trulyAccurate ? 'accept' : 'reject'
      wasCorrect = trulyAccurate
    } else if (proposal.type === 'budget') {
      // Бюджет меняет ТОЛЬКО владелец. Модель осторожного владельца: не
      // поднимаем бюджет по авто-предложению (отказ), сам вопрос — легитимен.
      action = 'reject'
      wasCorrect = true
    } else {
      // Незнакомый тип предложения — отказ, считаем сомнительным (штраф спама).
      action = 'reject'
      wasCorrect = false
    }

    const res = await deps.decide(proposal.id, action)
    if (res.ok) {
      decided.push({
        day,
        type: proposal.type,
        topicKey: proposal.topicKey,
        payloadSummary: JSON.stringify(proposal.payload).slice(0, 200),
        ownerDecision: action === 'accept' ? 'approved' : 'rejected',
        wasCorrect,
      })
    }
  }

  return decided
}
