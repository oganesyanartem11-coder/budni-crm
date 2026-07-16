/**
 * Сборка драфта СПОРНОГО минус-предложения владельцу (фикс 13.07, ШАГ 1/2).
 *
 * ЕДИНЫЙ источник формы payload минус-предложения — ключ `phrases` (его же читают
 * formatProposalSummary, apply-accepted.ts и ветка behavioral_minus). Раньше драфт
 * клал `phrases`, а счётчик formatProposalSummary читал `words` → «Минус-фразы: 0 шт»
 * при непустом списке. Здесь производитель драфта вынесен в чистую функцию, чтобы
 * писатель, счётчик и применятель не могли разойтись формой payload.
 *
 * Аргумент — от ФАКТА: есть расход → называем ₽ («съел X ₽ без заявок»); нет расхода
 * (0 кликов) → НЕ обещаем экономию (её нет), формулируем как чистку релевантности.
 *
 * Чистая функция, без IO. Типы ProposalDraft/MinusVerdictDraft импортируются как
 * type-only из brain (стираются при компиляции — рантайм-цикла нет).
 */
import type { ProposalDraft, MinusVerdictDraft } from './brain'
import { minusPhraseBlocksQuery } from './diagnostics'

/**
 * Все фразы кандидата УЖЕ заблокированы живым минус-списком кампании? Гейт границы
 * ПРЕДЛОЖЕНИЙ (зовётся в cron-роуте, НЕ в мозг-тике → полигон не трогаем): не
 * пере-предлагаем владельцу с кнопками фразу, которая давно в минусах кабинета
 * (BUG 2 re-proposal, аудит 16.07). Семантика блокировки — как в Директе
 * (minusPhraseBlocksQuery: все слова минус-фразы присутствуют в запросе). Гейтим
 * ТОЛЬКО когда ВСЕ фразы драфта уже минусованы (частичный драфт с новой фразой —
 * пропускаем как есть). Пустые списки → false (нечего гейтить).
 */
export function allPhrasesAlreadyMinused(phrases: string[], negatives: string[]): boolean {
  if (phrases.length === 0 || negatives.length === 0) return false
  return phrases.every((p) => negatives.some((neg) => minusPhraseBlocksQuery(neg, p)))
}

/** Минимум статистики кандидата для аргумента (структурно совместим с QueryStatRow). */
export interface MinusCandidateStat {
  impressions: number
  clicks: number
  costRub: number
}

export function buildDisputedMinusProposalDraft(
  disputed: string[],
  verdicts: MinusVerdictDraft[],
  statByQuery: ReadonlyMap<string, MinusCandidateStat>,
): ProposalDraft {
  const disputedVerdicts = verdicts.filter((v) => disputed.includes(v.candidate))
  const argumentParts = disputed.map((phrase) => {
    const s = statByQuery.get(phrase)
    return `«${phrase}» — ${s?.impressions ?? 0} показов, ${s?.clicks ?? 0} кликов, 0 заявок`
  })
  const totalCostRub = disputed.reduce((acc, p) => acc + (statByQuery.get(p)?.costRub ?? 0), 0)
  const triggerValue = disputed.reduce((acc, p) => acc + (statByQuery.get(p)?.impressions ?? 0), 0)

  // Закрывающий тезис — от факта: расход есть → называем ₽; расхода/кликов нет →
  // не обещаем экономию (её нет), чистим релевантность.
  const thesis =
    totalCostRub > 0
      ? `Съел ${Math.round(totalCostRub)} ₽ без заявок — минусовка уберёт нецелевой расход, больше заявок на рубль.`
      : 'Показы без интереса (0 кликов) — чистим релевантность.'

  return {
    type: 'minus_words',
    topicKey: 'minus_words',
    payload: { phrases: disputed, verdicts: disputedVerdicts },
    argument: `Запросы с объёмом показов и нулём заявок за период: ${argumentParts.join('; ')}. ${thesis}`,
    question: 'Занести в минусы?',
    triggerMetric: 'impressions_no_conversions',
    triggerValue,
  }
}
