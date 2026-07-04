// Чистые правила роли «трафик» (Борис-Директ): карантин, минусовка, ставки,
// circuit breaker. НИКАКОГО IO — только арифметика и сравнения.
//
// Принцип гибрида: ВСЯ арифметика (пороги, фильтры, сравнения, дедуп) живёт
// здесь, в коде. LLM получает готовые выводы и выносит только суждение.

import {
  QUARANTINE_DAYS,
  QUARANTINE_MIN_CLICKS,
  MINUS_MIN_IMPRESSIONS,
  MINUS_WORD_MAX_LEN,
  BID_CEILING_MICRO,
  CB_MAX_BID_CHANGES_PER_TICK,
  CB_MAX_BID_MASS_SHIFT,
} from './config'
import type { QueryStatRow } from './attribution'

// ---------- Карантин ----------

/**
 * Карантин молодой кампании: мало дней данных ИЛИ мало кликов суммарно.
 * В карантине НЕ оптимизируем (ни ставки, ни минуса) — только наблюдаем:
 * первые дни Яндекс показывает кампанию внизу независимо от ставки,
 * любые «выводы» на таком объёме — шум.
 */
export function isInQuarantine(input: { daysOfData: number; totalClicks: number }): boolean {
  return input.daysOfData < QUARANTINE_DAYS || input.totalClicks < QUARANTINE_MIN_CLICKS
}

// ---------- Нормализация слов ----------

/** Нормализация слова: lower, ё→е, trim. Для сравнений/дедупа, не для API. */
export function normalizeWord(w: string): string {
  return w.trim().toLowerCase().replace(/ё/g, 'е')
}

/**
 * Разбивает фразу на нормализованные слова. Операторы Директа (+ ! кавычки,
 * скобки) срезаются — для сравнения важны сами слова. Дефис ВНУТРИ слова
 * («бизнес-ланч») сохраняется.
 */
function tokenize(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((token) => normalizeWord(token.replace(/["«»[\]+!]/g, '').replace(/^-+/, '')))
    .filter((token) => token.length > 0)
}

/** Нормализованный вид всей фразы — ключ дедупа. */
function normalizePhrase(phrase: string): string {
  return tokenize(phrase).join(' ')
}

// ---------- Минусовка: механика Директа ----------

/** Символы, которые Директ не принимает в минус-фразах. */
const MINUS_FORBIDDEN_CHARS = /[/\\«»"]/

/**
 * Валидация минус-фразы по механике Директа: нельзя цифры и символы
 * / \ « » ", каждое слово не длиннее MINUS_WORD_MAX_LEN (иначе ошибка 5002).
 */
export function validateMinusPhrase(phrase: string): { ok: boolean; reason?: string } {
  const trimmed = phrase.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'пустая фраза' }
  }
  if (MINUS_FORBIDDEN_CHARS.test(trimmed)) {
    return { ok: false, reason: 'недопустимые символы (/ \\ « » ")' }
  }
  if (/\d/.test(trimmed)) {
    return { ok: false, reason: 'цифры в минус-фразах не допускаются' }
  }
  const tooLong = trimmed.split(/\s+/).find((word) => word.length > MINUS_WORD_MAX_LEN)
  if (tooLong) {
    return { ok: false, reason: `слово длиннее ${MINUS_WORD_MAX_LEN} символов: «${tooLong}»` }
  }
  return { ok: true }
}

// ---------- Минусовка: пересечение с ядром ----------

/**
 * Пересекается ли минус-фраза с ядром ключевых фраз.
 *
 * Токен УЗКИЙ: слово минус-фразы встречается словом в какой-то ключевой
 * фразе → пересечение. Для многословной (в т.ч. ДВУСЛОВНОЙ) минус-фразы
 * пересечение считается, только если ВСЕ её слова найдены в ОДНОЙ ключевой
 * фразе. Широкое родовое слово может задеть целевой B2B — поэтому при
 * пересечении кандидат отвергается из автономии (решает владелец).
 */
export function intersectsCore(phrase: string, coreKeywords: string[]): boolean {
  const minusWords = tokenize(phrase)
  if (minusWords.length === 0) return false
  return coreKeywords.some((keyword) => {
    const keywordWords = new Set(tokenize(keyword))
    return minusWords.every((word) => keywordWords.has(word))
  })
}

// ---------- Минусовка: подготовка кандидатов ----------

/**
 * Конвейер подготовки минус-кандидатов к автономии:
 * механика Директа (validateMinusPhrase) → ноль пересечений с ядром →
 * дедуп (по нормализации: между кандидатами и против existingMinus).
 */
export function prepareMinusCandidates(
  candidates: string[],
  opts: { coreKeywords: string[]; existingMinus: string[] }
): { accepted: string[]; rejected: Array<{ phrase: string; reason: string }> } {
  const accepted: string[] = []
  const rejected: Array<{ phrase: string; reason: string }> = []
  const seen = new Set(opts.existingMinus.map(normalizePhrase))

  for (const phrase of candidates) {
    const mechanics = validateMinusPhrase(phrase)
    if (!mechanics.ok) {
      rejected.push({ phrase, reason: mechanics.reason ?? 'механика Директа' })
      continue
    }
    if (intersectsCore(phrase, opts.coreKeywords)) {
      rejected.push({ phrase, reason: 'пересекается с ядром ключевых фраз' })
      continue
    }
    const norm = normalizePhrase(phrase)
    if (seen.has(norm)) {
      rejected.push({ phrase, reason: 'дубль (уже в списке или среди кандидатов)' })
      continue
    }
    seen.add(norm)
    accepted.push(phrase.trim())
  }

  return { accepted, rejected }
}

/**
 * Data-driven отбор минус-кандидатов из отчёта по поисковым запросам:
 * объём показов без конверсий за разумный период — impressions ≥
 * MINUS_MIN_IMPRESSIONS И conversions === 0. Одиночный показ — не повод.
 */
export function pickDataDrivenMinusCandidates(rows: QueryStatRow[]): string[] {
  return rows
    .filter((row) => row.impressions >= MINUS_MIN_IMPRESSIONS && row.conversions === 0)
    .map((row) => row.query)
    .filter((query) => query.trim().length > 0)
}

// ---------- Ставки: бинарная шкала ----------

/** Премиум-блок (TV 85/100) — НИКОГДА: рубеж ×3-4 по цене, заявки те же. */
const PREMIUM_TV_MIN = 85

/** Микрошум: |дельта| ставки < 5% — не дёргаем, экономим лимиты API. */
const BID_NOISE_RATIO = 0.05

export interface RecommendBidInput {
  auctionBids: Array<{ TrafficVolume: number; Bid: number; Price: number }>
  /**
   * Целевой уровень TV, выбранный ПОФРАЗНО по головной экономике фразы
   * (Цикл 2.0): конвертер → вход в нижний блок (TV_LOWER_BLOCK_ENTRY),
   * «горелка» → минимум (TV_TAIL), тонкая → вход. Значение сравнивается со
   * шкалой аукциона: берётся наименьший доступный TV ≥ desiredTv.
   */
  desiredTv: number
  currentBidMicro: number
}

export interface RecommendBidResult {
  targetBidMicro: number
  targetTv: number | null
  changed: boolean
  /**
   * Почему держимся (заполнено ТОЛЬКО при changed=false) — машинное
   * объяснение уже принятого решения, на само решение не влияет:
   * 'ceiling' — вход дороже потолка; 'noise' — микрошум/нулевые ставки;
   * 'no_auction' — нет подходящей позиции аукциона (пусто или только премиум).
   */
  holdReason?: 'ceiling' | 'noise' | 'no_auction'
}

/**
 * Рекомендация ставки по бинарной шкале аукциона (Цикл 2.0 — ПОФРАЗНО):
 * - целевой уровень desiredTv выбран вызывающим по головной экономике фразы;
 * - берётся наименьшая доступная позиция аукциона с TrafficVolume ≥ desiredTv;
 * - премиум (TV ≥ 85) — НИКОГДА (рубеж ×3-4 по цене), из кандидатов исключён.
 *
 * Всегда clamp к BID_CEILING_MICRO; если даже нужный вход дороже потолка —
 * не меняем (changed=false, targetTv=null). Микрошум < 5% — не меняем.
 */
export function recommendBid(input: RecommendBidInput): RecommendBidResult {
  // «Не менять» + машинная причина. Решение то же, что и раньше, — добавлено
  // только объяснение holdReason (эмиссия для полигона, не новая логика).
  const hold = (holdReason: 'ceiling' | 'noise' | 'no_auction'): RecommendBidResult => ({
    targetBidMicro: input.currentBidMicro,
    targetTv: null,
    changed: false,
    holdReason,
  })

  // Кандидаты — только НЕ премиум, по возрастанию объёма.
  const available = input.auctionBids
    .filter((b) => b.TrafficVolume < PREMIUM_TV_MIN)
    .sort((a, b) => a.TrafficVolume - b.TrafficVolume)
  if (available.length === 0) return hold('no_auction')

  const target = available.find((b) => b.TrafficVolume >= input.desiredTv)
  if (!target) return hold('no_auction')

  // Даже нужный вход дороже потолка → не лезем (потолок — предохранитель).
  if (target.Bid > BID_CEILING_MICRO) return hold('ceiling')

  const targetBidMicro = Math.min(target.Bid, BID_CEILING_MICRO)

  // Микрошум: не дёргаем ставку из-за колебаний аукциона < 5%.
  if (input.currentBidMicro > 0) {
    const delta = Math.abs(targetBidMicro - input.currentBidMicro) / input.currentBidMicro
    if (delta < BID_NOISE_RATIO) return hold('noise')
  } else if (targetBidMicro === 0) {
    return hold('noise')
  }

  return { targetBidMicro, targetTv: target.TrafficVolume, changed: true }
}

// ---------- Circuit breaker ----------

/**
 * Предохранитель от бага (не гейт): правка «дико вне паттерна» — слишком
 * много изменений за тик или скачок суммарной ставочной массы. При срабатывании
 * НЕ применять и писать владельцу (делает вызывающий код).
 */
export function checkCircuitBreaker(
  changes: Array<{ fromMicro: number; toMicro: number }>
): { ok: boolean; reason?: string } {
  if (changes.length > CB_MAX_BID_CHANGES_PER_TICK) {
    return {
      ok: false,
      reason: `слишком много правок ставок за тик: ${changes.length} > ${CB_MAX_BID_CHANGES_PER_TICK}`,
    }
  }
  if (changes.length === 0) return { ok: true }

  const sumFrom = changes.reduce((acc, c) => acc + c.fromMicro, 0)
  const sumTo = changes.reduce((acc, c) => acc + c.toMicro, 0)

  // ВАЖНО (Цикл 2.0): предохранитель защищает от РАЗГОНА РАСХОДА (баг раздувает
  // ставки). СНИЖЕНИЕ ставочной массы расход не разгоняет — это всегда безопасно
  // (пофразный экономбиддинг штатно режет беззаявочные фразы на >50% за тик).
  // Поэтому масс-шифт ловит только РОСТ; порог кол-ва правок (>N) остаётся
  // симметричным (баг, брызжущий сотней правок, подозрителен в любую сторону).

  // Текущая масса ноль, новая — растёт: рост «бесконечный», безопаснее стоп.
  if (sumFrom <= 0) {
    return sumTo > 0
      ? { ok: false, reason: 'ставочная масса растёт с нуля — вне паттерна, нужен разбор' }
      : { ok: true }
  }

  const increase = (sumTo - sumFrom) / sumFrom
  if (increase > CB_MAX_BID_MASS_SHIFT) {
    return {
      ok: false,
      reason: `рост ставочной массы ${(increase * 100).toFixed(0)}% > ${CB_MAX_BID_MASS_SHIFT * 100}% за тик`,
    }
  }
  return { ok: true }
}
