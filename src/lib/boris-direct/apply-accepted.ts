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
import { addNegativeKeywords, applyDailyBudget } from './write-gate'
import { MICRO } from './config'

export interface ApplyAcceptedResult {
  /** Реально применённые операции (гейт пропустил). */
  applied: string[]
  /** Не применённые с причиной: OBSERVE/стоп-кран, ручное применение, ошибка. */
  skipped: string[]
  /** Алёрты владельцу (fail-safe минусовки / рассинхрон кабинета) — шлёт крон в чат. */
  alerts: string[]
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
  skipped: string[],
  alerts: string[]
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
      // ЕДИНАЯ ТОЧКА: addNegativeKeywords мержит с ЖИВЫМ списком кабинета —
      // замещающий список строится внутри поверх реального содержимого, а не
      // из голых принятых фраз (иначе живой список кабинета был бы затёрт).
      const gate = await addNegativeKeywords(
        prepared.accepted,
        `принято владельцем: предложение ${proposal.id}`
      )
      if (gate.aborted) {
        // Fail-safe: живой список не прочитан / подозрительно усох — НЕ пометили
        // применённым, повторим на следующем тике, когда чтение восстановится.
        alerts.push(
          `⚠️ Принятые минусы (предложение ${proposal.id}) НЕ применил: ${gate.abortReason}. ` +
            `Список кабинета не тронут, повторю на следующем тике.`
        )
        skipped.push(`минус-фразы: fail-safe (${gate.abortReason}) — предложение ${proposal.id}, не помечаю применённым`)
        return
      }
      if (gate.writeErrors?.length) {
        // A: campaigns.update вернул HTTP 200 с Errors → write НЕ прошёл. Это НЕ
        // OBSERVE (не «сделал бы»): НЕ помечаем применённым (повтор на след. тике),
        // владельцу — алёрт с кодами ошибок дословно.
        alerts.push(
          `⚠️ Принятые минусы (предложение ${proposal.id}) НЕ применились в Директе (ошибки API): ` +
            `${gate.writeErrors.join('; ')}. Повторю на следующем тике.`
        )
        skipped.push(
          `минус-фразы: write-ошибка Директа (${gate.writeErrors.join('; ')}) — предложение ${proposal.id}, не помечаю применённым`
        )
        return
      }
      // В OBSERVE applied=false — всё равно помечаем: лог «сделал бы» остался,
      // повторно применять при смене режима будем уже по новым данным.
      await markProposalApplied(proposal.id)
      if (gate.verifyMismatch) {
        alerts.push(
          `⚠️ Минусы предложения ${proposal.id} применил, но контрольное чтение кабинета не сошлось — проверь список минус-фраз вручную.`
        )
      }
      // D: счётчик и список — НЕТТО-новые против живого кабинета (gate.added/addedPhrases),
      // а не число прошедших механику принятых (иначе завышает: часть уже в кабинете).
      const label = `минус-фразы (${gate.added}): ${gate.addedPhrases.join(', ')}`
      if (gate.applied) applied.push(label)
      else if (gate.added === 0)
        skipped.push(`минус-фразы: все кандидаты уже в списке кабинета (предложение ${proposal.id})`)
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
  const alerts: string[] = []

  const proposals = await getAcceptedUnapplied()
  for (const proposal of proposals) {
    try {
      await applyOne(proposal, applied, skipped, alerts)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[boris-direct/apply-accepted] предложение ${proposal.id} (${proposal.type}) не применилось`,
        err
      )
      skipped.push(
        `${proposal.type}: ошибка применения, попробую на следующем тике (предложение ${proposal.id})`
      )
      // C: тихого отказа применения принятого быть не должно — владельцу алёрт
      // (что и почему не применилось). Предложение НЕ помечено applied (throw
      // случился до markProposalApplied) → повтор на следующем тике.
      alerts.push(
        `⚠️ Принятое предложение ${proposal.id} (${proposal.type}) НЕ применилось из-за ошибки: ${message}. Повторю на следующем тике.`
      )
    }
  }

  return { applied, skipped, alerts }
}
