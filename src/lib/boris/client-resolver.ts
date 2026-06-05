/**
 * Строгий резолвер клиента по части имени (MEGA-4a, фикс П6).
 *
 * Проблема: substring-матчинг (prisma name.contains) без anchoring цепляет
 * паразитов. Запрос «инпарт авто» мог зацепить «Розница Инпарт соседи»,
 * «ИНПАРТ Логистика» и т.п. — и Боря угадывал не того клиента или включал
 * всех в план.
 *
 * Решение: широкий ILIKE-отсев в БД (дёшево сузить выборку), затем строгая
 * категоризация В ПАМЯТИ по НОРМАЛИЗОВАННЫМ именам:
 *   1) exact      — нормализованное имя === нормализованный запрос
 *   2) startsWith — нормализованное имя начинается с нормализованного запроса
 *   3) contains   — нормализованное имя содержит нормализованный запрос
 *   4) fuzzy      — Левенштейн ≤ 2 (опечатки), ТОЛЬКО когда чистые тиры 1-3 пусты
 *
 * suggested (единственный кандидат для автодействия) выдаётся ТОЛЬКО когда
 * однозначно: ровно один exact, ЛИБО ноль exact и ровно один startsWith,
 * ЛИБО ноль точных тиров и ровно один кандидат на минимальной дистанции ≤2.
 * Во всех прочих случаях suggested=null и rejected='ambiguous' — Боря обязан
 * переспросить менеджера, а не угадывать. contains НИКОГДА не становится
 * автокандидатом — только показывается как вариант выбора.
 *
 * Фаззи (Левенштейн) добавлен под прод-кейс: DB-клиент `ООО "ИНПАРТ АВТО"`,
 * менеджер пишет `импарт авто` (И→М, дистанция 1). Чистые тиры дают no_match
 * (ILIKE-подстрока не находит опечатку), фаззи находит единственного кандидата
 * на дистанции ≤2 и предлагает его. Если 2+ кандидата на минимальной
 * дистанции — ambiguous, а не угадывание.
 */

import type { Client, ClientLocation, PrismaClient } from '@prisma/client'

/** Локационная часть, нужная резолверу для same-day определения. */
type ResolverLocation = Pick<ClientLocation, 'id' | 'sameDayDelivery' | 'isActive'>

/** Client с подгруженными локациями (для вычисления isSameDayClient). */
export type ResolvedClient = Client & { locations: ResolverLocation[] }

export interface ResolveResult {
  /** Все попавшие кандидаты, упорядочены: exact → startsWith → contains. */
  matched: ResolvedClient[]
  exact: ResolvedClient[]
  startsWith: ResolvedClient[]
  contains: ResolvedClient[]
  /**
   * Кандидаты, найденные фаззи-матчингом (Левенштейн ≤2) на минимальной
   * дистанции. Заполняется ТОЛЬКО когда чистые тиры (exact/startsWith/contains)
   * пусты. Если ровно один — становится suggested; если ≥2 — ambiguous.
   */
  fuzzy: ResolvedClient[]
  /** Единственный безопасный кандидат для автодействия, либо null. */
  suggested: ResolvedClient | null
  rejected: 'no_match' | 'ambiguous' | null
  /**
   * MEGA-4a-fix: true, если у suggested есть хотя бы одна АКТИВНАЯ локация с
   * sameDayDelivery=true. SAME-DAY клиент сам подтверждает заказ утром в день
   * доставки — Боря не должен создавать ему предзаявку на будущую дату руками.
   * Относится к suggested; при suggested=null всегда false.
   */
  isSameDayClient: boolean
}

/** true если у клиента есть активная same-day локация. */
function hasActiveSameDayLocation(c: ResolvedClient | null): boolean {
  return c ? c.locations.some((l) => l.sameDayDelivery && l.isActive) : false
}

/** Юр.формы, которые срезаем как отдельный токен (не подстроку внутри слов). */
const LEGAL_FORMS = new Set(['ооо', 'ип', 'ао', 'зао', 'пао', 'оао', 'нко', 'тоо'])

/** Порог фаззи-матчинга (опечатки): расстояние Левенштейна ≤ FUZZY_MAX. */
const FUZZY_MAX = 2

/**
 * Расстояние Левенштейна (вставка/удаление/замена), итеративно по одной строке
 * (O(min(a,b)) памяти). Локальная реализация — в проекте нет fuzzy-зависимости
 * (проверено: нет fastest-levenshtein / string-similarity / leven), новую не
 * вводим.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost)
      diag = tmp
    }
  }
  return prev[b.length]
}

/**
 * Нормализация имени клиента:
 * - lowercase
 * - удаление всех видов кавычек (« » " " " ' ' ' ` и обычные ' ")
 * - удаление юр.форм (ООО/ОАО/АО/ИП/ПАО/ЗАО/НКО/ТОО) как отдельных токенов
 * - collapse множественных пробелов + trim
 */
export function normalizeClientName(raw: string): string {
  if (!raw) return ''
  const noQuotes = raw
    // Кавычки всех мастей → пробел (чтобы «ООО"ИНПАРТ"» не слиплось).
    .replace(/[«»“”„‟"‘’‚‛'`]/g, ' ')
    .toLowerCase()

  const tokens = noQuotes
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !LEGAL_FORMS.has(t))

  return tokens.join(' ')
}

export async function resolveClient(
  query: string,
  prisma: PrismaClient,
): Promise<ResolveResult> {
  const normQuery = normalizeClientName(query)

  const empty: ResolveResult = {
    matched: [],
    exact: [],
    startsWith: [],
    contains: [],
    fuzzy: [],
    suggested: null,
    rejected: 'no_match',
    isSameDayClient: false,
  }

  if (normQuery.length === 0) {
    return empty
  }

  // Широкий отсев в БД: ILIKE contains по очищенному (от юр.форм/кавычек)
  // запросу. Это лишь СУЖАЕТ выборку — финальная категоризация строгая и в
  // памяти. ILIKE по normQuery дёшев и достаточно широк (юр.формы в name не
  // мешают, т.к. в памяти мы их нормализуем).
  const candidates = await prisma.client.findMany({
    where: {
      isActive: true,
      name: { contains: normQuery, mode: 'insensitive' },
    },
    include: {
      locations: { select: { id: true, sameDayDelivery: true, isActive: true } },
    },
  })

  const exact: ResolvedClient[] = []
  const startsWith: ResolvedClient[] = []
  const contains: ResolvedClient[] = []

  for (const c of candidates) {
    const normName = normalizeClientName(c.name)
    if (normName === normQuery) {
      exact.push(c)
    } else if (normName.startsWith(normQuery)) {
      startsWith.push(c)
    } else if (normName.includes(normQuery)) {
      contains.push(c)
    }
    // else: ILIKE зацепил по «грязному» имени, но после нормализации совпадения
    // нет — отбрасываем (например юр.форма в середине запроса).
  }

  // Фаззи-тир: ТОЛЬКО когда чистые тиры пусты (exact/startsWith/contains).
  // Это покрывает опечатки (импарт→инпарт), которые ILIKE-подстрока не находит,
  // поэтому исходный ILIKE-отсев тут не помогает — берём ВСЕХ активных клиентов
  // и считаем Левенштейн в памяти. Выборка широкая, но запускается лишь когда
  // строгие тиры провалились (редкий путь), а не на каждый запрос.
  const fuzzy: ResolvedClient[] = []
  if (exact.length === 0 && startsWith.length === 0 && contains.length === 0) {
    const all = await prisma.client.findMany({
      where: { isActive: true },
      include: {
        locations: { select: { id: true, sameDayDelivery: true, isActive: true } },
      },
    })

    let bestDist = FUZZY_MAX + 1
    for (const c of all) {
      const d = levenshtein(normalizeClientName(c.name), normQuery)
      if (d > FUZZY_MAX) continue
      if (d < bestDist) {
        bestDist = d
        fuzzy.length = 0
        fuzzy.push(c)
      } else if (d === bestDist) {
        fuzzy.push(c)
      }
    }
  }

  const matched = [...exact, ...startsWith, ...contains, ...fuzzy]

  if (matched.length === 0) {
    return {
      matched,
      exact,
      startsWith,
      contains,
      fuzzy,
      suggested: null,
      rejected: 'no_match',
      isSameDayClient: false,
    }
  }

  // Приоритет: exact > startsWith > fuzzy(единственный на мин.дистанции).
  // contains НИКОГДА не автокандидат. Фаззи участвует, лишь когда чистые тиры
  // пусты (по построению fuzzy непустой только в этом случае).
  let suggested: ResolvedClient | null = null
  if (exact.length === 1) {
    suggested = exact[0]
  } else if (exact.length === 0 && startsWith.length === 1) {
    suggested = startsWith[0]
  } else if (
    exact.length === 0 &&
    startsWith.length === 0 &&
    contains.length === 0 &&
    fuzzy.length === 1
  ) {
    suggested = fuzzy[0]
  }

  const rejected: ResolveResult['rejected'] = suggested === null ? 'ambiguous' : null

  return {
    matched,
    exact,
    startsWith,
    contains,
    fuzzy,
    suggested,
    rejected,
    isSameDayClient: hasActiveSameDayLocation(suggested),
  }
}
