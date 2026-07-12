/**
 * Живая конвертер-память (М4 ШАГ 4). Чистые функции, без IO.
 *
 * Вход БЕЗ деплоя: живой CriterionId, получивший ≥1 Директ-конверсию в окне,
 * заносится как ACTIVE-конвертер (дата + evidence) и получает ту же защиту, что
 * реестровые (converters.ts): не демоутится / не минусуется / не выключается.
 *
 * Выход-храповик: CONVERTER_STALE_WINDOWS полных окон подряд (клики ≥
 * PHRASE_MIN_CLICKS за окно) с 0 конверсий → STALE (защита снята, запись с
 * историей остаётся; новая конверсия → снова ACTIVE). Мало кликов — окно НЕ
 * полное, храповик не тикает (не наказываем за отсутствие данных).
 *
 * Реестр-константа (5 фраз в converters.ts) — ЖЁСТКАЯ страховка ПОВЕРХ: реестровый
 * не стареет никогда. Здесь — только ДИНАМИЧЕСКАЯ память по CriterionId.
 *
 * Персист — снапшот kind='converter_memory' в BorisDirectSnapshot (без миграций,
 * payload=JSON), тем же паттерном, что level-lock (phrase_tv_lock): читаем свежий,
 * обновляем, пишем. Выбор снапшота, а не Lesson-механики: храповик — ПОТИКОВЫЙ
 * автомат по CriterionId на Директ-конверсиях (та же кадентность и источник, что
 * level-lock), тогда как Lesson выводится ЕЖЕНЕДЕЛЬНО по группам/исходам — иная
 * кадентность; смешивать их не следует.
 */

import { CONVERTER_STALE_WINDOWS, PHRASE_MIN_CLICKS } from './config'

export type ConverterStatus = 'ACTIVE' | 'STALE'

export interface ConverterMemoryEntry {
  criterionId: number
  /** Текст ключа (для отображения/ОПЫТ/защиты минусов по тексту). */
  phrase: string
  status: ConverterStatus
  /** Дата первой активации, МСК 'YYYY-MM-DD' (сохраняется при реактивации). */
  activatedMsk: string
  /** Дата последней конверсии, МСК. */
  lastConversionMsk: string | null
  /** Конверсии окна (доказательство). */
  conversions: number
  /** Счётчик ПОДРЯД полных пустых окон (храповик). */
  emptyWindows: number
}

/** Ключ карты — String(criterionId). */
export type ConverterMemory = Record<string, ConverterMemoryEntry>

/** Агрегат окна по одному живому CriterionId (клики+конверсии за окно защиты). */
export interface ConverterWindowStat {
  criterionId: number
  phrase: string
  clicks: number
  conversions: number
}

export interface UpdateConverterMemoryInput {
  prev: ConverterMemory
  window: ConverterWindowStat[]
  todayMsk: string
  /** Живые ключи кабинета — записи снятых/удалённых ключей прунятся (не тащим вечно). */
  liveIds: Set<number>
}

/**
 * Один тик автомата конвертер-памяти. Чистая: prev не мутируется.
 * Вход по конверсии, храповик по полным пустым окнам, прунинг мёртвых ключей.
 */
export function updateConverterMemory(input: UpdateConverterMemoryInput): ConverterMemory {
  const next: ConverterMemory = {}
  // Переносим существующие записи ТОЛЬКО по живым ключам (прунинг орфанов).
  for (const [key, entry] of Object.entries(input.prev)) {
    if (input.liveIds.has(entry.criterionId)) next[key] = { ...entry }
  }

  for (const w of input.window) {
    if (!input.liveIds.has(w.criterionId)) continue
    const key = String(w.criterionId)
    const existing = next[key]

    if (w.conversions >= 1) {
      // Активация / подтверждение: сброс храповика, дата конверсии.
      next[key] = {
        criterionId: w.criterionId,
        phrase: w.phrase || existing?.phrase || key,
        status: 'ACTIVE',
        activatedMsk: existing?.activatedMsk ?? input.todayMsk,
        lastConversionMsk: input.todayMsk,
        conversions: w.conversions,
        emptyWindows: 0,
      }
      continue
    }

    // 0 конверсий в окне.
    if (!existing) continue // записи нет — по нулю не создаём
    if (w.clicks < PHRASE_MIN_CLICKS) continue // окно не полное — храповик не тикает
    const emptyWindows = existing.emptyWindows + 1
    next[key] = {
      ...existing,
      phrase: w.phrase || existing.phrase,
      emptyWindows,
      status: emptyWindows >= CONVERTER_STALE_WINDOWS ? 'STALE' : existing.status,
    }
  }

  return next
}

/** ID ACTIVE-конвертеров (защита ставок по CriterionId). */
export function activeConverterIds(mem: ConverterMemory): Set<number> {
  const ids = new Set<number>()
  for (const e of Object.values(mem)) if (e.status === 'ACTIVE') ids.add(e.criterionId)
  return ids
}

/** ACTIVE-конвертеры как уроки для секции «ОПЫТ» (LessonForContext-совместимо). */
export function converterMemoryLessonsForContext(
  mem: ConverterMemory
): Array<{ id: string; kind: string; text: string }> {
  return Object.values(mem)
    .filter((e) => e.status === 'ACTIVE')
    .map((e) => ({
      id: `converter-live:${e.criterionId}`,
      kind: 'converter',
      text:
        `Фраза «${e.phrase}» — живой КОНВЕРТЕР под защитой (заявок ${e.conversions}` +
        `${e.lastConversionMsk ? `, посл. ${e.lastConversionMsk}` : ''}): не минусовать, не выключать, не понижать ставку с мотивом «дорого».`,
    }))
}
