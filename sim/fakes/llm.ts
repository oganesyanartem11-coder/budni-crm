/**
 * Фейк LLM-обвязки для полигона: подмена callBorisDirectLlm.
 *
 * purpose === 'minus_classify' (единственный LLM-вызов мозга):
 *  - llmMode 'stub' — детерминированная эвристика без сети: кандидаты
 *    парсятся из call.userText (мозг шлёт JSON-массив
 *    [{candidate, impressions, clicks, conversions}] — см. brain.ts),
 *    маркеры мусора → structural:true + confident:true, иначе оба false;
 *  - llmMode 'live' — настоящий вызов через impl из setLiveLlmImpl
 *    (раннер передаёт боевой callBorisDirectLlm через vi.importActual)
 *    с ДИСКОВЫМ кешем sim/cache/llm-cache.json (ключ sha1(userText)):
 *    повторные прогоны матрицы не жгут токены.
 *
 * Прочие purpose → детерминированная заглушка 'sim-stub' (тексты отчётов
 * полигон не оценивает по содержанию).
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCtx } from './context'
import type {
  BorisDirectLlmCall,
  BorisDirectLlmResult,
} from '../../src/lib/boris-direct/llm'

// Паритет типов с реальным модулем (type-only — стирается).
export type {
  BorisDirectLlmCall,
  BorisDirectLlmResult,
  LlmTier,
} from '../../src/lib/boris-direct/llm'

/** Дисковый кеш live-режима: sim/cache/llm-cache.json (пути от этого файла). */
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'llm-cache.json')

// ---------- live-режим: настоящий вызов задаёт раннер ----------

type LiveLlmImpl = (call: BorisDirectLlmCall) => Promise<BorisDirectLlmResult>

let liveImpl: LiveLlmImpl | null = null

/**
 * Раннер передаёт сюда боевой callBorisDirectLlm (vi.importActual) перед
 * live-прогоном; null — сброс. Без impl live-режим падает громко.
 */
export function setLiveLlmImpl(fn: LiveLlmImpl | null): void {
  liveImpl = fn
}

// ---------- Разбор кандидатов из userText мозга ----------

/**
 * brain.ts строит userText классификатора так:
 *   JSON.stringify(prepared.accepted.map((phrase) => ({ candidate: phrase,
 *     impressions, clicks, conversions })))
 * Парсим робастно: первый '['..последний ']', элементы — объекты с полем
 * candidate (строка) ЛИБО просто строки. Мусор/битый JSON → [] (все
 * кандидаты остаются спорными — безопасное направление ошибки, как в мозге).
 */
export function parseClassifierCandidates(userText: string): string[] {
  try {
    const start = userText.indexOf('[')
    const end = userText.lastIndexOf(']')
    if (start === -1 || end <= start) return []
    const parsed: unknown = JSON.parse(userText.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item === 'string') {
        out.push(item)
        continue
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const candidate = (item as Record<string, unknown>).candidate
        if (typeof candidate === 'string') out.push(candidate)
      }
    }
    return out
  } catch {
    return []
  }
}

// ---------- stub-режим: эвристика структурного мусора ----------

/**
 * Маркеры мусора для нашего бизнеса (доставка обедов на коллективы, Москва
 * и МО): города вне зоны, «бесплатно», рецепты/самоделки, вакансии, учёба.
 */
const TRASH_MARKERS =
  /(казань|екатеринбург|спб|питер|новосибирск|краснодар|бесплатно|рецепт|своими руками|вакансии|работа|курсовая|реферат|б\/у)/

interface StubVerdict {
  candidate: string
  structural: boolean
  confident: boolean
  reason: string
}

/** Вердикт по одному кандидату — детерминированный (нижний регистр, ё→е). */
function stubVerdict(candidate: string): StubVerdict {
  const normalized = candidate.toLowerCase().replace(/ё/g, 'е')
  const match = normalized.match(TRASH_MARKERS)
  if (match) {
    return {
      candidate,
      structural: true,
      confident: true,
      reason: `стаб: маркер мусора «${match[1]}»`,
    }
  }
  return {
    candidate,
    structural: false,
    confident: false,
    reason: 'стаб: маркеров мусора нет — спорный кандидат',
  }
}

function stubClassify(userText: string): BorisDirectLlmResult {
  const verdicts = parseClassifierCandidates(userText).map(stubVerdict)
  return { text: JSON.stringify(verdicts), model: 'stub', costUsd: 0, downgraded: false }
}

// ---------- Дисковый кеш live-режима ----------

type LlmCache = Record<string, BorisDirectLlmResult>

function cacheKey(userText: string): string {
  return createHash('sha1').update(userText).digest('hex')
}

function readCache(): LlmCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as LlmCache)
      : {}
  } catch {
    // Файла нет / битый JSON → пустой кеш (перезапишется при первом промахе).
    return {}
  }
}

function writeCache(cache: LlmCache): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

async function liveClassify(call: BorisDirectLlmCall): Promise<BorisDirectLlmResult> {
  const key = cacheKey(call.userText)
  const cache = readCache()
  const hit = cache[key]
  if (hit) return hit
  if (!liveImpl) {
    throw new Error(
      '[sim/fakes/llm] llmMode=live, но setLiveLlmImpl не вызван — раннер обязан передать боевой callBorisDirectLlm (vi.importActual) до прогона'
    )
  }
  const result = await liveImpl(call)
  cache[key] = result
  writeCache(cache)
  return result
}

// ---------- Точка подмены ----------

/** Подмена callBorisDirectLlm: сигнатура один в один с боевой. */
export async function fakeCallBorisDirectLlm(
  call: BorisDirectLlmCall
): Promise<BorisDirectLlmResult> {
  const ctx = getCtx()

  if (call.purpose === 'minus_classify') {
    return ctx.llmMode === 'live' ? liveClassify(call) : stubClassify(call.userText)
  }

  // Прочие вызовы (тексты отчётов и т.п.) — контент полигон не оценивает.
  return { text: 'sim-stub', model: 'stub', costUsd: 0, downgraded: false }
}
