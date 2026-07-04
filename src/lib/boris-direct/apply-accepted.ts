/**
 * Применение ПРИНЯТЫХ владельцем предложений (Борис-Директ).
 *
 * Вызывается из process-крона: колбэк кнопки «✅ Да» только меняет статус
 * предложения (proposals.decideProposal), а к Директу принятое применяет
 * дневной цикл — этот модуль. Каждый тип предложения знает свой способ
 * применения; ошибка одного предложения не роняет остальные.
 *
 * ИНВАРИАНТ: applyDailyBudget зовётся ТОЛЬКО отсюда — дневной бюджет
 * меняется исключительно после явного «да» владельца по предложению.
 */

import type { BorisDirectProposal } from '@prisma/client'
import { getAcceptedUnapplied, markProposalApplied } from './proposals'
import { prepareMinusCandidates } from './rules'
import { applyNegativeKeywords, applyDailyBudget } from './write-gate'
import { MICRO } from './config'

export interface ApplyAcceptedResult {
  /** Реально применённые операции (гейт пропустил). */
  applied: string[]
  /** Не применённые с причиной: OBSERVE/стоп-кран, ручное применение, ошибка. */
  skipped: string[]
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/** Одно предложение → применение по типу. Ошибки ловит вызывающий. */
async function applyOne(
  proposal: BorisDirectProposal,
  applied: string[],
  skipped: string[]
): Promise<void> {
  const payload = asRecord(proposal.payload)

  switch (proposal.type) {
    case 'minus_words': {
      const phrases = Array.isArray(payload.phrases)
        ? payload.phrases.filter((p): p is string => typeof p === 'string')
        : []
      // Владелец уже решил — ядро НЕ проверяем (пустой список), но механику
      // Директа (символы/длина/дедуп) прогоняем всё равно: битая фраза
      // уронит campaigns.update целиком.
      const prepared = prepareMinusCandidates(phrases, { coreKeywords: [], existingMinus: [] })
      if (prepared.accepted.length === 0) {
        await markProposalApplied(proposal.id)
        skipped.push(
          `минус-фразы: все ${phrases.length} кандидатов отсеяны механикой Директа (предложение ${proposal.id})`
        )
        return
      }
      const gate = await applyNegativeKeywords(
        prepared.accepted,
        [],
        `принято владельцем: предложение ${proposal.id}`
      )
      // В OBSERVE applied=false — всё равно помечаем: лог «сделал бы» остался,
      // повторно применять при смене режима будем уже по новым данным.
      await markProposalApplied(proposal.id)
      const label = `минус-фразы (${prepared.accepted.length}): ${prepared.accepted.join(', ')}`
      if (gate.applied) applied.push(label)
      else skipped.push(`${label} — не применено (наблюдение/стоп-кран), залогировано как «сделал бы»`)
      return
    }

    case 'budget': {
      const amountMicro = typeof payload.amountMicro === 'number' ? payload.amountMicro : null
      if (amountMicro === null) {
        await markProposalApplied(proposal.id)
        skipped.push(
          `бюджет: в payload нет amountMicro — требует ручного применения (предложение ${proposal.id})`
        )
        return
      }
      // ЕДИНСТВЕННОЕ место, откуда меняется дневной бюджет.
      const gate = await applyDailyBudget(
        amountMicro,
        `явное да владельца: предложение ${proposal.id}`
      )
      await markProposalApplied(proposal.id)
      const label = `дневной бюджет: ${Math.round(amountMicro / MICRO)} ₽`
      if (gate.applied) applied.push(label)
      else skipped.push(`${label} — не применено (наблюдение/стоп-кран), залогировано как «сделал бы»`)
      return
    }

    case 'lift_minus_gate':
      // Гейт уже снят при клике владельца (setAutoNegativesEnabled в
      // decideProposal) — применять нечего, просто помечаем; в skipped не пишем.
      await markProposalApplied(proposal.id)
      return

    default:
      // Неизвестный тип: помечаем (чтобы не крутить вечно) и честно говорим.
      await markProposalApplied(proposal.id)
      skipped.push(`${proposal.type}: требует ручного применения (предложение ${proposal.id})`)
  }
}

/**
 * Применить все принятые владельцем и ещё не применённые предложения.
 * try/catch на каждом: ошибка одного не роняет остальные, упавшее НЕ
 * помечается applied — попробуем на следующем тике.
 */
export async function applyAcceptedProposals(): Promise<ApplyAcceptedResult> {
  const applied: string[] = []
  const skipped: string[] = []

  const proposals = await getAcceptedUnapplied()
  for (const proposal of proposals) {
    try {
      await applyOne(proposal, applied, skipped)
    } catch (err) {
      console.error(
        `[boris-direct/apply-accepted] предложение ${proposal.id} (${proposal.type}) не применилось`,
        err
      )
      skipped.push(
        `${proposal.type}: ошибка применения, попробую на следующем тике (предложение ${proposal.id})`
      )
    }
  }

  return { applied, skipped }
}
