/**
 * МЕТАМОРФИЧЕСКИЕ ПРОВЕРКИ ПОЛИГОНА: инварианты, обязанные выживать при
 * безобидных трансформациях мира (переименование групп, чистый шум).
 *
 * Сравниваем не путь (дни, промежуточные ходы), а ФИНАЛЬНЫЕ решения:
 * (1) множество минус-запросов на конец прогона;
 * (2) знак чистого сдвига ставки по каждой фразе (вверх/вниз/не трогал).
 * Чистые функции: без сети/Math.random/часов.
 */

import type { RunResult } from '../types'
import { type BidPoint, bidSequences, finalNegatives } from './scorer'

/** Направление чистого сдвига ставки фразы за прогон. */
export type BidDirection = 'вверх' | 'вниз' | 'без сдвига' | 'не трогал'

/**
 * Знак финального изменения: последний bid_set против первого. Стартовые
 * ставки сюда не передаются — оба прогона считаются ОДНОЙ меркой, поэтому
 * одиночный bid_set даёт «без сдвига» симметрично для A и B (инвариантность
 * от этого не страдает: трогал/не трогал и знак сравниваются честно).
 */
function bidDirection(seq: BidPoint[] | undefined): BidDirection {
  if (!seq || seq.length === 0) return 'не трогал'
  const delta = seq[seq.length - 1].toMicro - seq[0].toMicro
  if (delta > 0) return 'вверх'
  if (delta < 0) return 'вниз'
  return 'без сдвига'
}

/** Первая зафиксированная группа фразы в прогоне (фейк пишет её в payload bid_set). */
function groupOf(seq: BidPoint[] | undefined): string | undefined {
  for (const p of seq ?? []) if (p.adGroupId !== undefined) return p.adGroupId
  return undefined
}

/**
 * Сравнить финальные решения двух прогонов одного сценария.
 *
 * relabelGroups — словарь переименования групп ДЛЯ B (groupId мира B →
 * groupId мира A): метаморфический прогон B на мире с переименованными
 * группами обязан дать те же решения, что A на исходном.
 */
export function compareDecisionSets(
  a: RunResult,
  b: RunResult,
  relabelGroups?: Map<string, string>,
): { ok: boolean; diffs: string[] } {
  const diffs: string[] = []

  // (1) Множества финальных минус-запросов (порядок не важен, сравниваем как set).
  const negA = new Set(finalNegatives(a))
  const negB = new Set(finalNegatives(b))
  for (const q of [...negA].sort()) if (!negB.has(q)) diffs.push(`минус «${q}»: есть в A, нет в B`)
  for (const q of [...negB].sort()) if (!negA.has(q)) diffs.push(`минус «${q}»: есть в B, нет в A`)

  // (2) По каждой фразе — знак финального сдвига ставки + группа (с релейблом для B).
  const seqA = bidSequences(a)
  const seqB = bidSequences(b)
  const kwIds = [...new Set([...seqA.keys(), ...seqB.keys()])].sort((x, y) => x - y)
  for (const kwId of kwIds) {
    const dirA = bidDirection(seqA.get(kwId))
    const dirB = bidDirection(seqB.get(kwId))
    if (dirA !== dirB) diffs.push(`фраза ${kwId}: ставка в A «${dirA}», в B «${dirB}»`)

    const gA = groupOf(seqA.get(kwId))
    const gBRaw = groupOf(seqB.get(kwId))
    const gB = gBRaw === undefined ? undefined : (relabelGroups?.get(gBRaw) ?? gBRaw)
    if (gA !== undefined && gB !== undefined && gA !== gB) {
      diffs.push(`фраза ${kwId}: группа в A «${gA}», в B после релейбла «${gB}»`)
    }
  }

  return { ok: diffs.length === 0, diffs }
}

/**
 * Шумовой инвариант: на сценарии из чистого статистического шума
 * дисциплинированный аналитик НЕ минусует ничего. Считаем ВСЕ запросы,
 * когда-либо попадавшие в negatives_set за прогон — «поставил и откатил»
 * тоже нарушение (деньги и трафик уже пострадали).
 */
export function assertNoNegativesOnNoise(run: RunResult): { ok: boolean; negatives: number } {
  const seen = new Set<string>()
  for (const action of run.actions) {
    if (action.type !== 'negatives_set' || !Array.isArray(action.payload)) continue
    for (const q of action.payload as unknown[]) {
      if (typeof q === 'string' && q.length > 0) seen.add(q)
    }
  }
  return { ok: seen.size === 0, negatives: seen.size }
}
