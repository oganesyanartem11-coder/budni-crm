/**
 * «Борис, почему <фраза>» (М4 ШАГ 1): прозрачность решений владельцу.
 *
 * Текст фразы → CriterionId (нормализация + поиск по снапшоту keywords) → записи
 * по этому ID из последних снапшотов decision-trace (kind='decisions') → light-LLM
 * пересказ голосом Бориса с ЦИФРАМИ (числа только из данных). LLM упал → детермини-
 * рованный фолбэк (цифры без нарратива). ТОЛЬКО ЧТЕНИЕ — ни одного write.
 */

import { prisma } from '@/lib/db/prisma'
import { callBorisDirectLlm } from './llm'
import { getBorisDirectSystemPrompt } from './prompts'
import { getDirectRoleState } from './state'
import { normalizeConverterPhrase } from './converters'
import { MICRO } from './config'
import type { DecisionRecord } from './reason-codes'

/** Сколько последних снапшотов трассы просматриваем. */
const EXPLAIN_TRACE_SNAPSHOTS = 7

interface KeywordRec {
  Id: number
  Keyword: string
}

async function loadLatestKeywords(): Promise<KeywordRec[]> {
  const snap = await prisma.borisDirectSnapshot.findFirst({
    where: { kind: 'keywords' },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
  })
  const list = snap?.payload as unknown as KeywordRec[]
  return Array.isArray(list) ? list : []
}

async function loadRecentDecisions(): Promise<DecisionRecord[]> {
  const snaps = await prisma.borisDirectSnapshot.findMany({
    where: { kind: 'decisions' },
    orderBy: [{ tickDate: 'desc' }, { createdAt: 'desc' }],
    take: EXPLAIN_TRACE_SNAPSHOTS,
  })
  const out: DecisionRecord[] = []
  for (const s of snaps) {
    const list = s.payload as unknown as DecisionRecord[]
    if (Array.isArray(list)) out.push(...list)
  }
  return out
}

function words(s: string): string[] {
  return s.split(' ').filter(Boolean)
}

/** Похожие живые ключи: общая подстрока или общий токен с запросом (до 5). */
function suggestSimilar(keywords: KeywordRec[], query: string): string[] {
  const qWords = new Set(words(query))
  const near: string[] = []
  for (const k of keywords) {
    const n = normalizeConverterPhrase(k.Keyword)
    const hit = n.includes(query) || query.includes(n) || words(n).some((w) => qWords.has(w))
    if (hit) near.push(k.Keyword)
    if (near.length >= 5) break
  }
  return near
}

function rub(micro: unknown): string {
  return typeof micro === 'number' ? String(Math.round(micro / MICRO)) : '?'
}

/** Детерминированный пересказ без LLM: суть каждой записи + её цифры из factors. */
function deterministicExplain(keyword: string, records: DecisionRecord[]): string {
  const lines = records.map((d) => {
    const f = (d.factors ?? {}) as Record<string, unknown>
    const nums: string[] = []
    if (typeof f.headClicks === 'number') nums.push(`клики ${f.headClicks}`)
    if (typeof f.headLeads === 'number') nums.push(`заявки ${f.headLeads}`)
    if (typeof f.pBelow === 'number') nums.push(`P<порога ${f.pBelow}`)
    if (typeof f.fromMicro === 'number') nums.push(`ставка ${rub(f.fromMicro)} ₽`)
    if (typeof f.toMicro === 'number') nums.push(`→ ${rub(f.toMicro)} ₽`)
    if (typeof f.targetTv === 'number') nums.push(`TV${f.targetTv}`)
    const tail = nums.length ? ` (${nums.join(', ')})` : ''
    return `- ${d.summary}${tail}`
  })
  return [`По фразе «${keyword}» мои последние решения:`, ...lines].join('\n')
}

/**
 * Ответ на «Борис, почему <фраза>». Всегда возвращает текст владельцу (честный
 * «не нашёл» — тоже валидный ответ). Ни один вызов не пишет в Директ/БД.
 */
export async function explainPhrase(rawPhrase: string): Promise<string> {
  const query = normalizeConverterPhrase(rawPhrase)
  if (!query) return 'Скажи фразу после «почему» — по какой именно объяснить.'

  const keywords = await loadLatestKeywords()
  const match = keywords.find((k) => normalizeConverterPhrase(k.Keyword) === query)
  if (!match) {
    const near = suggestSimilar(keywords, query)
    if (near.length === 0) {
      return `Не нашёл фразу «${rawPhrase}» среди живых ключей кампании.`
    }
    return `Не нашёл точную «${rawPhrase}» среди живых ключей. Похожие: ${near.join('; ')}.`
  }

  const decisions = await loadRecentDecisions()
  const mine = decisions.filter((d) => d.targetId === String(match.Id))
  if (mine.length === 0) {
    return `По ключу «${match.Keyword}» решений за последние дни не записано — ставку не трогал, либо тик по нему молчал.`
  }

  const fallback = deterministicExplain(match.Keyword, mine)
  try {
    const state = await getDirectRoleState()
    const system =
      getBorisDirectSystemPrompt({ mode: state.mode, frozen: state.frozen }) +
      '\n\nЗАДАЧА: перескажи владельцу СВОИ последние решения по одной фразе — коротко, живым языком, с цифрами. Цифры бери ТОЛЬКО из данных (клики, заявки, ставки, TV, P<порога), ничего не выдумывай и не пересчитывай. Без markdown, 2–4 строки.'
    const llm = await callBorisDirectLlm({
      purpose: 'explain_phrase',
      tier: 'light',
      system,
      userText: JSON.stringify({ phrase: match.Keyword, decisions: mine }),
      maxTokens: 512,
    })
    return llm.text?.trim() || fallback
  } catch (err) {
    console.error('[boris-direct/explain] LLM упал — детерминированный фолбэк', err)
    return fallback
  }
}
