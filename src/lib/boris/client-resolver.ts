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

  const matched = [...exact, ...startsWith, ...contains]

  if (matched.length === 0) {
    return {
      matched,
      exact,
      startsWith,
      contains,
      suggested: null,
      rejected: 'no_match',
      isSameDayClient: false,
    }
  }

  let suggested: ResolvedClient | null = null
  if (exact.length === 1) {
    suggested = exact[0]
  } else if (exact.length === 0 && startsWith.length === 1) {
    suggested = startsWith[0]
  }

  const rejected: ResolveResult['rejected'] = suggested === null ? 'ambiguous' : null

  return {
    matched,
    exact,
    startsWith,
    contains,
    suggested,
    rejected,
    isSameDayClient: hasActiveSameDayLocation(suggested),
  }
}
