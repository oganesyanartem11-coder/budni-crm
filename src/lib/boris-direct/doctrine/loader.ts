// Загрузчик доктрины: валидация карточек + отбор top-K по темам под токен-кэп
// + рендер секции «СПРАВОЧНАЯ ДОКТРИНА» для LLM-промптов.
//
// Приоритет типов: MECHANIC > LIMIT > RECOMMENDATION. CONFLICTS исключены по
// умолчанию (только под includeConflicts). REFUTED_BY_EXPERIENCE и STALE
// исключены ВСЕГДА (в промпты не попадают — ШАГ 7).

import {
  DoctrineCardSchema,
  type DoctrineCard,
  type DoctrineType,
  type DoctrineSourceTier,
} from './schema'
import { RAW_DOCTRINE } from './items'

/** Приоритет типов при отборе (меньше = важнее). */
const TYPE_PRIORITY: Record<DoctrineType, number> = { MECHANIC: 0, LIMIT: 1, RECOMMENDATION: 2 }

/**
 * Тай-брейк по ДОВЕРИЮ ИСТОЧНИКА (ШАГ 3): официальная Справка приоритетнее Ярда.
 * Если по одной MECHANIC-теме карточки OFFICIAL_HELP и YARD противоречат —
 * в выборку раньше попадёт OFFICIAL_HELP (первоисточник «перевешивает» вторичный).
 * Это ТАЙ-БРЕЙК ОТБОРА для промптов, а НЕ изменение порогов/предохранителей —
 * на код-решения доктрина по-прежнему не влияет.
 */
const TIER_PRIORITY: Record<DoctrineSourceTier, number> = { OFFICIAL_HELP: 0, YARD: 1, OTHER: 2 }

/**
 * Валидирует все карточки один раз при загрузке модуля. Битая карточка
 * ИСКЛЮЧАЕТСЯ с логом (роль не роняем), но тест схемы (schema.test.ts) ловит
 * такое в CI — в прод битые карточки не попадают.
 */
function loadValidatedCards(): DoctrineCard[] {
  const out: DoctrineCard[] = []
  for (const raw of RAW_DOCTRINE) {
    const parsed = DoctrineCardSchema.safeParse(raw)
    if (parsed.success) {
      out.push(parsed.data)
    } else {
      const id = (raw as { id?: string })?.id ?? '(нет id)'
      console.error(
        `[boris-direct/doctrine] невалидная карточка исключена: ${id} — ${parsed.error.issues[0]?.message}`
      )
    }
  }
  return out
}

const ALL_CARDS: DoctrineCard[] = loadValidatedCards()

/** Все валидные карточки (для тестов/аудита/моста опыта). */
export function getAllDoctrineCards(): DoctrineCard[] {
  return ALL_CARDS
}

/** Грубая оценка токенов карточки (консервативно: ~3 символа кириллицы = 1 токен). */
export function estimateCardTokens(card: DoctrineCard): number {
  const conflict = card.conflictNote ? card.conflictNote.length : 0
  return Math.ceil((card.claim.length + conflict + 24) / 3)
}

export interface GetDoctrineOpts {
  /** Максимум карточек в выборке (дефолт 12). */
  maxItems?: number
  /** Токен-кэп выборки (дефолт 1200) — доктрина не может раздуть промпт. */
  maxTokens?: number
  /** Пускать ли CONFLICTS-карточки (по умолчанию нет). */
  includeConflicts?: boolean
}

/**
 * ЧИСТЫЙ отбор: из переданного набора карточек выбирает релевантные тегам,
 * сортирует по приоритету типа (MECHANIC>LIMIT>RECOMMENDATION), затем HIGH
 * перед MEDIUM, и режет по maxItems/maxTokens. Тестируется на синтетике.
 *
 * ВСЕГДА исключает REFUTED_BY_EXPERIENCE / STALE. CONFLICTS — только при
 * includeConflicts. Пустой tags = «все темы».
 */
export function selectDoctrine(
  cards: DoctrineCard[],
  tags: string[],
  opts: GetDoctrineOpts = {}
): DoctrineCard[] {
  const { maxItems = 12, maxTokens = 1200, includeConflicts = false } = opts
  const wanted = new Set(tags)

  const pool = cards
    .filter(
      (c) =>
        c.status === 'ACTIVE' &&
        (includeConflicts || c.projectStance !== 'CONFLICTS') &&
        (wanted.size === 0 || c.tags.some((t) => wanted.has(t)))
    )
    .sort(
      (a, b) =>
        TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] ||
        // Тай-брейк по доверию источника: OFFICIAL_HELP > YARD > OTHER.
        TIER_PRIORITY[a.sourceTier] - TIER_PRIORITY[b.sourceTier] ||
        (a.confidence === b.confidence ? 0 : a.confidence === 'HIGH' ? -1 : 1)
    )

  const selected: DoctrineCard[] = []
  let tokens = 0
  for (const card of pool) {
    if (selected.length >= maxItems) break
    const t = estimateCardTokens(card)
    // Кэп соблюдаем, но не режем до нуля: хотя бы одна карточка пройдёт.
    if (tokens + t > maxTokens && selected.length > 0) continue
    tokens += t
    selected.push(card)
  }
  return selected
}

/** Отбор доктрины по тегам из ВСЕГО загруженного набора. */
export function getDoctrine(tags: string[], opts: GetDoctrineOpts = {}): DoctrineCard[] {
  return selectDoctrine(ALL_CARDS, tags, opts)
}

/**
 * Преамбула секции доктрины: доктрина — СПРАВКА, не приказ. Предохранители
 * кода и собственный опыт кампании ВАЖНЕЕ. Конфликтная рекомендация —
 * максимум гипотеза владельцу, никогда не действие. Механика — sanity-check.
 */
export const DOCTRINE_PREAMBLE =
  'Это внешняя справка Яндекса о механике Директа/Метрики — СПРАВКА, а НЕ приказ. ' +
  'Предохранители кода и СОБСТВЕННЫЙ опыт кампании ВАЖНЕЕ доктрины. ' +
  'Конфликтная рекомендация — максимум ГИПОТЕЗА владельцу, НИКОГДА не действие. ' +
  'Механику используй как sanity-check объяснений: вывод, противоречащий механике, помечай противоречием.'

function typeLabel(t: DoctrineType): string {
  return t === 'MECHANIC' ? 'МЕХАНИКА' : t === 'LIMIT' ? 'ЛИМИТ' : 'СОВЕТ ЯНДЕКСА'
}

/**
 * Рендер секции «СПРАВОЧНАЯ ДОКТРИНА» для системного промпта. Пустой набор →
 * пустая строка (никаких пустых заголовков).
 */
export function renderDoctrineBlock(cards: DoctrineCard[]): string {
  if (cards.length === 0) return ''
  const lines = cards.map((c) => {
    const conflict =
      c.projectStance === 'CONFLICTS' && c.conflictNote
        ? ` [КОНФЛИКТ С НАШИМ ПРАВИЛОМ: ${c.conflictNote}]`
        : ''
    return `- [${typeLabel(c.type)}] ${c.claim}${conflict}`
  })
  return `## СПРАВОЧНАЯ ДОКТРИНА\n${DOCTRINE_PREAMBLE}\n\n${lines.join('\n')}`
}

/** Удобный шорткат: отобрать по тегам и сразу отрендерить блок. */
export function getDoctrineBlock(tags: string[], opts: GetDoctrineOpts = {}): string {
  return renderDoctrineBlock(getDoctrine(tags, opts))
}

// ---------- Мост опыт↔доктрина (ШАГ 5) ----------

/** Карточки, опровергнутые опытом кампании (status REFUTED_BY_EXPERIENCE). */
export function filterRefuted(cards: DoctrineCard[]): DoctrineCard[] {
  return cards.filter((c) => c.status === 'REFUTED_BY_EXPERIENCE')
}

/** Опровергнутые опытом карточки из всего набора (для строки в недельном отчёте). */
export function getRefutedCards(): DoctrineCard[] {
  return filterRefuted(ALL_CARDS)
}

/**
 * Строки «КОНФЛИКТЫ ЗНАНИЕ/ОПЫТ» для недельного отчёта: где справка Яндекса
 * (доктрина) была опровергнута собственным опытом кампании (со ссылкой на урок,
 * не удаляя — аудит). Пусто → пустой массив (никаких пустых заголовков).
 */
export function renderKnowledgeExperienceConflicts(refuted: DoctrineCard[]): string[] {
  if (refuted.length === 0) return []
  return [
    'КОНФЛИКТЫ ЗНАНИЕ/ОПЫТ (доктрина опровергнута опытом кампании):',
    ...refuted.map((c) => {
      const ref = c.refutedBy?.lessonRef ?? '(без ссылки на урок)'
      const note = c.refutedBy?.note ? ` — ${c.refutedBy.note}` : ''
      const claim = c.claim.length > 90 ? `${c.claim.slice(0, 90)}…` : c.claim
      return `- «${claim}» опроверг урок ${ref}${note}`
    }),
  ]
}
