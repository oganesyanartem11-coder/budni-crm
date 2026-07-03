/**
 * Фейк-присма полигона Бориса-Директа: in-memory имитация РОВНО тех вызовов
 * Prisma, которые делает боевой код (grep «prisma.» по src/lib/boris-direct/*.ts
 * и src/lib/leads/*.ts, 2026-07):
 *
 * - borisDirectState:          findUnique, upsert (unique key)
 * - borisDirectSnapshot:       create, findFirst, findMany (+select, +distinct)
 * - borisDirectReportJob:      create, update, updateMany, findFirst, findMany
 * - borisDirectActionLog:      create, update, findFirst, findMany
 * - borisDirectProposal:       create, update, updateMany, findUnique, findFirst, findMany
 * - borisDirectMinusVerdict:   createMany, updateMany, findMany (+take)
 * - borisDirectLlmLog:         create, aggregate (_sum/_count)
 * - borisDirectQueryDailyStat: upsert (составной unique date_query_adGroupId), findMany
 * - borisDirectLesson:         create, update, findMany
 * - landingLead:               create, count, findMany
 *
 * Поддержанная грамматика:
 * - where: равенство (примитив/Date/null), { in: [...] }, { not: null|значение },
 *   { gte / gt / lte / lt } по датам/числам/строкам (комбинируются AND-ом);
 * - orderBy: одно поле или массив однополевых записей ('asc'|'desc';
 *   null-значения как в Postgres: ASC — последними, DESC — первыми);
 * - take (целое ≥ 0), select (возвращаются ТОЛЬКО выбранные поля), distinct;
 * - updateMany/createMany → { count }; aggregate → { _sum, _count: {_all} }.
 *
 * ЛЮБОЙ незнакомый паттерн → Error('unsupported query: ...') ГРОМКО:
 * молчаливое враньё фейка опаснее упавшего прогона.
 *
 * id = 'sim<счётчик>'; createdAt/updatedAt/requestedAt по умолчанию =
 * виртуальная дата часов контекста (МСК-полдень дня clockDay — попадает
 * внутрь оконных выборок мозга по mskDayStartUtc).
 *
 * Замечания о верности имитации:
 * - Decimal-поля (costRub, costUsd, triggerValue) хранятся числами — боевой
 *   код читает их через Number(...), поведение совпадает;
 * - Json-поля хранятся по ссылке (боевой код сам делает JSON-round-trip
 *   перед записью); вложенные атомарные операции ({increment} и пр.)
 *   НЕ поддержаны — боевой код их не использует.
 */

type Row = Record<string, unknown>

/** Фейк-присме от контекста нужны только виртуальные часы. */
export interface SimClock {
  currentDate(): Date
}

// ---------- Громкие ошибки ----------

function unsupported(detail: string): never {
  throw new Error(`[sim/fakes/prisma] unsupported query: ${detail}`)
}

/** Незнакомый ключ аргументов (include, skip, cursor…) — сразу ошибка. */
function assertAllowedKeys(args: Row | undefined, allowed: string[], op: string): void {
  if (!args) return
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) unsupported(`${op}: аргумент «${key}» не поддержан`)
  }
}

// ---------- Значения и сравнения ----------

function isPlainValue(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    v instanceof Date
  )
}

/** Равенство как в БД: даты по моменту, остальное строго. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  return a === b
}

/** Ранг для порядковых сравнений (gte/lt, orderBy). null обрабатывается выше. */
function rankOf(v: unknown, op: string): number | string {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return unsupported(`${op}: значение не сравнимо порядково (${typeof v})`)
}

function compareRanks(a: number | string, b: number | string, op: string): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : a < b ? -1 : 1
  return unsupported(`${op}: сравнение значений разных типов (${typeof a} и ${typeof b})`)
}

// ---------- where ----------

function matchCondition(value: unknown, cond: unknown, op: string): boolean {
  if (cond === undefined) return true // Prisma: undefined = поле не фильтруется
  if (isPlainValue(cond)) return valuesEqual(value, cond)

  if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)) {
    for (const [key, expected] of Object.entries(cond as Row)) {
      if (expected === undefined) continue
      switch (key) {
        case 'in': {
          if (!Array.isArray(expected)) unsupported(`${op}: оператор in ждёт массив`)
          if (!expected.some((e) => valuesEqual(value, e))) return false
          break
        }
        case 'not': {
          if (expected === null) {
            if (value === null || value === undefined) return false
          } else if (isPlainValue(expected)) {
            if (valuesEqual(value, expected)) return false
          } else {
            unsupported(`${op}: not поддержан только с null или примитивом`)
          }
          break
        }
        case 'gte':
        case 'gt':
        case 'lte':
        case 'lt': {
          // NULL не сравним ни с чем (семантика SQL) — строка не проходит.
          if (value === null || value === undefined) return false
          const cmp = compareRanks(rankOf(value, op), rankOf(expected, op), op)
          if (key === 'gte' && cmp < 0) return false
          if (key === 'gt' && cmp <= 0) return false
          if (key === 'lte' && cmp > 0) return false
          if (key === 'lt' && cmp >= 0) return false
          break
        }
        default:
          unsupported(`${op}: оператор «${key}» не поддержан`)
      }
    }
    return true
  }
  return unsupported(`${op}: условие такого вида не поддержано`)
}

function matchWhere(row: Row, where: Row | undefined, op: string): boolean {
  if (!where) return true
  for (const [field, cond] of Object.entries(where)) {
    if (field === 'AND' || field === 'OR' || field === 'NOT') {
      unsupported(`${op}: логический оператор ${field} не поддержан`)
    }
    if (!matchCondition(row[field], cond, `${op}.where.${field}`)) return false
  }
  return true
}

// ---------- orderBy / select / distinct ----------

type OrderDir = 'asc' | 'desc'

function normalizeOrderBy(orderBy: unknown, op: string): Array<[string, OrderDir]> {
  if (orderBy === undefined) return []
  const list = Array.isArray(orderBy) ? orderBy : [orderBy]
  const entries: Array<[string, OrderDir]> = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      unsupported(`${op}: orderBy-запись должна быть объектом {поле: 'asc'|'desc'}`)
    }
    const pairs = Object.entries(item as Row)
    if (pairs.length !== 1) unsupported(`${op}: orderBy-запись должна иметь ровно одно поле`)
    const [field, dir] = pairs[0]
    if (dir !== 'asc' && dir !== 'desc') unsupported(`${op}: orderBy.${field}=${String(dir)}`)
    entries.push([field, dir])
  }
  return entries
}

/** Сортировка стабильная; null: ASC — последними, DESC — первыми (Postgres). */
function applyOrderBy(rows: Row[], orderBy: unknown, op: string): Row[] {
  const entries = normalizeOrderBy(orderBy, op)
  if (entries.length === 0) return rows
  return [...rows].sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = a[field]
      const bv = b[field]
      const aNull = av === null || av === undefined
      const bNull = bv === null || bv === undefined
      if (aNull || bNull) {
        if (aNull && bNull) continue
        const nullLast = dir === 'asc' ? 1 : -1
        return aNull ? nullLast : -nullLast
      }
      const cmp = compareRanks(rankOf(av, op), rankOf(bv, op), op)
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

/** select: вернуть ТОЛЬКО выбранные поля (вложенные select не поддержаны). */
function applySelect(row: Row, select: unknown, op: string): Row {
  if (select === undefined) return { ...row }
  if (!select || typeof select !== 'object' || Array.isArray(select)) {
    unsupported(`${op}: select должен быть объектом {поле: true}`)
  }
  const out: Row = {}
  for (const [field, on] of Object.entries(select as Row)) {
    if (on === false || on === undefined) continue
    if (on !== true) unsupported(`${op}: select.${field} — поддержано только true/false`)
    out[field] = row[field]
  }
  return out
}

function applyDistinct(rows: Row[], distinct: unknown, op: string): Row[] {
  if (distinct === undefined) return rows
  if (!Array.isArray(distinct) || distinct.some((f) => typeof f !== 'string')) {
    unsupported(`${op}: distinct должен быть массивом имён полей`)
  }
  const fields = distinct as string[]
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const key = fields
      .map((f) => {
        const v = row[f]
        if (v instanceof Date) return `d${v.getTime()}`
        return JSON.stringify(v) ?? 'undefined'
      })
      .join(' ')
    if (!seen.has(key)) {
      seen.add(key)
      out.push(row)
    }
  }
  return out
}

// ---------- Модель ----------

interface ModelSpec {
  /** Имя модели (для сообщений об ошибках). */
  name: string
  /** У модели есть @updatedAt (BorisDirectState, BorisDirectLesson). */
  hasUpdatedAt?: boolean
  /** Unique-ключи: одиночные и составные (имя составного — как в Prisma). */
  uniques?: Array<{ name: string; fields: string[] }>
  /** Дефолты полей схемы при create (id/createdAt/updatedAt — общие). */
  defaults?: (now: Date) => Row
}

interface FindArgs {
  where?: Row
  orderBy?: unknown
  take?: number
  select?: unknown
  distinct?: unknown
}

export class FakeModel {
  private rows: Row[] = []

  constructor(
    private readonly clock: SimClock,
    private readonly nextId: () => string,
    private readonly spec: ModelSpec
  ) {}

  reset(): void {
    this.rows = []
  }

  private op(method: string): string {
    return `${this.spec.name}.${method}`
  }

  /** Строка из data + дефолты; undefined-значения data игнорируются (Prisma). */
  private buildRow(data: Row): Row {
    const now = this.clock.currentDate()
    const row: Row = {
      id: this.nextId(),
      createdAt: now,
      ...(this.spec.hasUpdatedAt ? { updatedAt: now } : {}),
      ...(this.spec.defaults?.(now) ?? {}),
    }
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) row[k] = v
    }
    return row
  }

  private assertUnique(candidate: Row, op: string): void {
    for (const unique of this.spec.uniques ?? []) {
      const clash = this.rows.some((r) =>
        unique.fields.every((f) => valuesEqual(r[f], candidate[f]))
      )
      if (clash) {
        throw new Error(
          `[sim/fakes/prisma] ${op}: нарушение unique(${unique.fields.join(', ')}) — запись уже существует`
        )
      }
    }
  }

  private applyData(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue
      row[k] = v
    }
    if (this.spec.hasUpdatedAt) row.updatedAt = this.clock.currentDate()
  }

  /**
   * Фильтр по where с валидацией: прогоняем условие по пустой строке ДО
   * фильтрации, чтобы незнакомый оператор падал громко даже на пустой таблице
   * (filter по [] иначе вообще не вызвал бы матчер).
   */
  private filter(where: Row | undefined, op: string): Row[] {
    if (where) matchWhere({}, where, op)
    return this.rows.filter((r) => matchWhere(r, where, op))
  }

  /**
   * Разрешение unique-селектора (findUnique/update/upsert): ровно один ключ —
   * id, зарегистрированное unique-поле или имя составного ключа с объектом.
   */
  private resolveUnique(where: Row, op: string): Row | undefined {
    const keys = Object.keys(where).filter((k) => where[k] !== undefined)
    if (keys.length !== 1) unsupported(`${op}: where должен указывать ровно один unique-ключ`)
    const key = keys[0]
    const value = where[key]

    const composite = (this.spec.uniques ?? []).find((u) => u.name === key && u.fields.length > 1)
    if (composite) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        unsupported(`${op}: составной ключ ${key} ждёт объект полей`)
      }
      const parts = value as Row
      const extra = Object.keys(parts).filter((f) => !composite.fields.includes(f))
      if (extra.length > 0) unsupported(`${op}: лишние поля в ${key}: ${extra.join(', ')}`)
      return this.rows.find((r) => composite.fields.every((f) => valuesEqual(r[f], parts[f])))
    }

    const isUniqueField =
      key === 'id' ||
      (this.spec.uniques ?? []).some((u) => u.fields.length === 1 && u.fields[0] === key)
    if (!isUniqueField) unsupported(`${op}: поле «${key}» не является unique-ключом`)
    if (!isPlainValue(value)) unsupported(`${op}: значение unique-ключа должно быть примитивом`)
    return this.rows.find((r) => valuesEqual(r[key], value))
  }

  // ---------- CRUD ----------

  async create(args: { data: Row }): Promise<Row> {
    const op = this.op('create')
    assertAllowedKeys(args as Row, ['data'], op)
    const row = this.buildRow(args.data)
    this.assertUnique(row, op)
    this.rows.push(row)
    return { ...row }
  }

  async createMany(args: { data: Row[] }): Promise<{ count: number }> {
    const op = this.op('createMany')
    assertAllowedKeys(args as Row, ['data'], op)
    if (!Array.isArray(args.data)) unsupported(`${op}: data должен быть массивом`)
    for (const data of args.data) {
      const row = this.buildRow(data)
      this.assertUnique(row, op)
      this.rows.push(row)
    }
    return { count: args.data.length }
  }

  async findMany(args?: FindArgs): Promise<Row[]> {
    const op = this.op('findMany')
    assertAllowedKeys(args as Row | undefined, ['where', 'orderBy', 'take', 'select', 'distinct'], op)
    let rows = this.filter(args?.where, op)
    rows = applyOrderBy(rows, args?.orderBy, op)
    rows = applyDistinct(rows, args?.distinct, op)
    if (args?.take !== undefined) {
      if (!Number.isInteger(args.take) || args.take < 0) unsupported(`${op}: take=${args.take}`)
      rows = rows.slice(0, args.take)
    }
    return rows.map((r) => applySelect(r, args?.select, op))
  }

  async findFirst(args?: FindArgs): Promise<Row | null> {
    const rows = await this.findMany(args)
    return rows[0] ?? null
  }

  async findUnique(args: { where: Row; select?: unknown }): Promise<Row | null> {
    const op = this.op('findUnique')
    assertAllowedKeys(args as Row, ['where', 'select'], op)
    const row = this.resolveUnique(args.where, op)
    return row ? applySelect(row, args.select, op) : null
  }

  async update(args: { where: Row; data: Row }): Promise<Row> {
    const op = this.op('update')
    assertAllowedKeys(args as Row, ['where', 'data'], op)
    const row = this.resolveUnique(args.where, op)
    if (!row) {
      // Как P2025 у Prisma: update по несуществующей записи — ошибка.
      throw new Error(`[sim/fakes/prisma] ${op}: запись не найдена (${JSON.stringify(args.where)})`)
    }
    this.applyData(row, args.data)
    return { ...row }
  }

  async updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
    const op = this.op('updateMany')
    assertAllowedKeys(args as Row, ['where', 'data'], op)
    const matches = this.filter(args.where, op)
    for (const row of matches) this.applyData(row, args.data)
    return { count: matches.length }
  }

  async upsert(args: { where: Row; create: Row; update: Row }): Promise<Row> {
    const op = this.op('upsert')
    assertAllowedKeys(args as Row, ['where', 'create', 'update'], op)
    const existing = this.resolveUnique(args.where, op)
    if (existing) {
      this.applyData(existing, args.update)
      return { ...existing }
    }
    const row = this.buildRow(args.create)
    this.assertUnique(row, op)
    this.rows.push(row)
    return { ...row }
  }

  async count(args?: { where?: Row }): Promise<number> {
    const op = this.op('count')
    assertAllowedKeys(args as Row | undefined, ['where'], op)
    return this.filter(args?.where, op).length
  }

  async aggregate(args: {
    where?: Row
    _sum?: Row
    _count?: Row
  }): Promise<{ _sum?: Record<string, number | null>; _count?: { _all: number } }> {
    const op = this.op('aggregate')
    assertAllowedKeys(args as Row, ['where', '_sum', '_count'], op)
    const rows = this.filter(args.where, op)
    const result: { _sum?: Record<string, number | null>; _count?: { _all: number } } = {}
    if (args._sum) {
      const sum: Record<string, number | null> = {}
      for (const [field, on] of Object.entries(args._sum)) {
        if (on !== true) unsupported(`${op}: _sum.${field} — поддержано только true`)
        const values = rows
          .map((r) => r[field])
          .filter((v): v is number => typeof v === 'number')
        // Как у Prisma: нет строк (или все null) → null, не 0.
        sum[field] = values.length > 0 ? values.reduce((a, b) => a + b, 0) : null
      }
      result._sum = sum
    }
    if (args._count) {
      const keys = Object.keys(args._count)
      if (keys.length !== 1 || keys[0] !== '_all' || args._count._all !== true) {
        unsupported(`${op}: _count поддержан только в виде { _all: true }`)
      }
      result._count = { _all: rows.length }
    }
    return result
  }
}

// ---------- Фабрика ----------

export interface FakePrisma {
  borisDirectState: FakeModel
  borisDirectSnapshot: FakeModel
  borisDirectReportJob: FakeModel
  borisDirectActionLog: FakeModel
  borisDirectProposal: FakeModel
  borisDirectMinusVerdict: FakeModel
  borisDirectLlmLog: FakeModel
  borisDirectQueryDailyStat: FakeModel
  borisDirectLesson: FakeModel
  landingLead: FakeModel
  /** Полная очистка всех таблиц и счётчика id (зовёт reset() контекста). */
  $reset(): void
}

/**
 * In-memory Prisma одного прогона. clock — виртуальные часы контекста
 * (SimContext подходит структурно: у него есть currentDate()).
 */
export function createFakePrisma(clock: SimClock): FakePrisma {
  let idSeq = 0
  const nextId = () => `sim${++idSeq}`
  const make = (spec: ModelSpec) => new FakeModel(clock, nextId, spec)

  // Дефолты — зеркало prisma/schema.prisma (@default соответствующих моделей).
  const models = {
    borisDirectState: make({
      name: 'borisDirectState',
      hasUpdatedAt: true,
      uniques: [{ name: 'key', fields: ['key'] }],
      defaults: () => ({
        key: 'main',
        mode: 'OBSERVE',
        frozen: false,
        autoNegativesEnabled: false,
        modeChangedAt: null,
        frozenChangedAt: null,
      }),
    }),
    borisDirectSnapshot: make({ name: 'borisDirectSnapshot' }),
    borisDirectReportJob: make({
      name: 'borisDirectReportJob',
      uniques: [{ name: 'reportName', fields: ['reportName'] }],
      defaults: (now) => ({
        status: 'PENDING',
        tsv: null,
        attempts: 0,
        error: null,
        requestedAt: now,
        readyAt: null,
        processedAt: null,
      }),
    }),
    borisDirectActionLog: make({
      name: 'borisDirectActionLog',
      defaults: () => ({
        targetId: null,
        before: null,
        after: null,
        revertedAt: null,
        revertOfId: null,
        outcomeVerdict: null,
        outcomeMeasuredAt: null,
        outcomeData: null,
      }),
    }),
    borisDirectProposal: make({
      name: 'borisDirectProposal',
      defaults: () => ({
        status: 'PENDING',
        question: null,
        triggerMetric: null,
        triggerValue: null,
        cooldownUntil: null,
        tgMessageId: null,
        decidedAt: null,
        outcomeVerdict: null,
        outcomeMeasuredAt: null,
        outcomeData: null,
      }),
    }),
    borisDirectMinusVerdict: make({
      name: 'borisDirectMinusVerdict',
      defaults: () => ({
        ownerDecision: null,
        matched: null,
        proposalId: null,
        decidedAt: null,
      }),
    }),
    borisDirectLlmLog: make({
      name: 'borisDirectLlmLog',
      defaults: () => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 0,
        durationMs: 0,
        ok: true,
        errorMessage: null,
      }),
    }),
    borisDirectQueryDailyStat: make({
      name: 'borisDirectQueryDailyStat',
      uniques: [{ name: 'date_query_adGroupId', fields: ['date', 'query', 'adGroupId'] }],
      defaults: () => ({
        impressions: 0,
        clicks: 0,
        costRub: 0,
        conversions: 0,
      }),
    }),
    borisDirectLesson: make({
      name: 'borisDirectLesson',
      hasUpdatedAt: true,
      defaults: () => ({
        subjectId: null,
        confidence: 0.5,
        status: 'ACTIVE',
        weeksConfirmed: 0,
        lastConfirmedAt: null,
        refutedAt: null,
      }),
    }),
    landingLead: make({
      name: 'landingLead',
      defaults: () => ({
        name: null,
        phoneDigits: null,
        source: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        yclid: null,
        gclid: null,
        pageUrl: null,
        pageReferrer: null,
        answers: null,
        meta: null,
        dealStatus: 'NONE',
        dealAmount: null,
        offlineConversionSentAt: null,
      }),
    }),
  }

  return {
    ...models,
    $reset(): void {
      idSeq = 0
      for (const model of Object.values(models)) model.reset()
    },
  }
}
