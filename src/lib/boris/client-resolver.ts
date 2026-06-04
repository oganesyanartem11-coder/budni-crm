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
 *
 * suggested (единственный кандидат для автодействия) выдаётся ТОЛЬКО когда
 * однозначно: ровно один exact, ЛИБО ноль exact и ровно один startsWith.
 * Во всех прочих случаях suggested=null и rejected='ambiguous' — Боря обязан
 * переспросить менеджера, а не угадывать. contains НИКОГДА не становится
 * автокандидатом — только показывается как вариант выбора.
 */

import type { Client, PrismaClient } from '@prisma/client'

export interface ResolveResult {
  /** Все попавшие кандидаты, упорядочены: exact → startsWith → contains. */
  matched: Client[]
  exact: Client[]
  startsWith: Client[]
  contains: Client[]
  /** Единственный безопасный кандидат для автодействия, либо null. */
  suggested: Client | null
  rejected: 'no_match' | 'ambiguous' | null
}

/** Юр.формы, которые срезаем как отдельный токен (не подстроку внутри слов). */
const LEGAL_FORMS = new Set(['ооо', 'ип', 'ао', 'зао', 'пао'])

/**
 * Нормализация имени клиента:
 * - lowercase
 * - удаление всех видов кавычек (« » " " " ' ' ' ` и обычные ' ")
 * - удаление юр.форм (ООО/ИП/АО/ЗАО/ПАО) как отдельных токенов
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
    suggested: null,
    rejected: 'no_match',
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
  })

  const exact: Client[] = []
  const startsWith: Client[] = []
  const contains: Client[] = []

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

  const matched = [...exact, ...startsWith, ...contains]

  if (matched.length === 0) {
    return { matched, exact, startsWith, contains, suggested: null, rejected: 'no_match' }
  }

  let suggested: Client | null = null
  if (exact.length === 1) {
    suggested = exact[0]
  } else if (exact.length === 0 && startsWith.length === 1) {
    suggested = startsWith[0]
  }

  const rejected: ResolveResult['rejected'] = suggested === null ? 'ambiguous' : null

  return { matched, exact, startsWith, contains, suggested, rejected }
}
