/**
 * Аналитика приёмок (накладных) — Sprint 7.MEGA-CLEANUP, BLOCK A.
 *
 * Все запросы фильтруются по Invoice.status='ACCEPTED' и acceptedAt ∈ [from..to].
 * Decimal → number конверсия на границе через Number(...). Где возможно — используем
 * groupBy/aggregate вместо N+1 ручных циклов (см. дисклеймер в material-cost.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { formatInTimeZone } from 'date-fns-tz'
import { ru } from 'date-fns/locale'
import { getMondayOfWeek, getSundayOfWeek } from '@/lib/utils/week'
import type { IngredientUnit } from '@prisma/client'

const MSK_TIMEZONE = 'Europe/Moscow'
const MSK_OFFSET_MS = 3 * 3600 * 1000

// ============================================================
// W1. Top-10 поставщиков по объёму
// ============================================================

export type SupplierTopRow = {
  supplierName: string
  total: number
  invoiceCount: number
}

/**
 * Группируем по supplierNameLower (Postgres collation-insensitive ключ),
 * для UI берём первый non-empty supplierName в группе.
 */
export async function getTopSuppliers({
  from,
  to,
  limit = 10,
}: {
  from: Date
  to: Date
  limit?: number
}): Promise<SupplierTopRow[]> {
  // groupBy по supplierNameLower — одинаковый поставщик с разным регистром
  // и пробелами схлопывается в одну строку. Один SQL-запрос.
  const grouped = await prisma.invoice.groupBy({
    by: ['supplierNameLower'],
    where: {
      status: 'ACCEPTED',
      acceptedAt: { gte: from, lte: to },
    },
    _sum: { totalAmount: true },
    _count: { _all: true },
    orderBy: { _sum: { totalAmount: 'desc' } },
    take: limit,
  })

  if (grouped.length === 0) return []

  // Берём «представительский» supplierName для каждого Lower-ключа —
  // первый по acceptedAt (DESC) — наиболее свежий вариант названия.
  const lowers = grouped.map((g) => g.supplierNameLower)
  const samples = await prisma.invoice.findMany({
    where: {
      status: 'ACCEPTED',
      acceptedAt: { gte: from, lte: to },
      supplierNameLower: { in: lowers },
    },
    select: { supplierName: true, supplierNameLower: true, acceptedAt: true },
    orderBy: { acceptedAt: 'desc' },
  })
  const displayNameByLower = new Map<string, string>()
  for (const s of samples) {
    if (!displayNameByLower.has(s.supplierNameLower)) {
      displayNameByLower.set(s.supplierNameLower, s.supplierName)
    }
  }

  return grouped.map((g) => ({
    supplierName: displayNameByLower.get(g.supplierNameLower) ?? g.supplierNameLower,
    total: Number(g._sum.totalAmount ?? 0),
    invoiceCount: g._count._all,
  }))
}

// ============================================================
// W2. Top-10 ингредиентов по росту цены
// ============================================================

export type PriceGrowthRow = {
  ingredientId: string
  name: string
  oldPrice: number
  newPrice: number
  changePercent: number
  acceptedAt: Date
}

/**
 * Берём строки накладных за период с matchedIngredientId NOT NULL и
 * priceChangePercent NOT NULL. Для каждого ингредиента — самая свежая
 * по invoice.acceptedAt строка. Сортируем DESC по priceChangePercent
 * (показываем именно ингредиенты с РОСТОМ цены — это то что бьёт по марже,
 * падение цены — приятная новость, не алерт).
 */
export async function getTopPriceGrowth({
  from,
  to,
  limit = 10,
}: {
  from: Date
  to: Date
  limit?: number
}): Promise<PriceGrowthRow[]> {
  // Сразу JOIN'им invoice + ingredient, фильтр по invoice.status/acceptedAt.
  const lines = await prisma.invoiceLine.findMany({
    where: {
      matchedIngredientId: { not: null },
      priceChangePercent: { not: null },
      pricePerKgNormalized: { not: null },
      previousPricePerKg: { not: null },
      invoice: {
        status: 'ACCEPTED',
        acceptedAt: { gte: from, lte: to },
      },
    },
    select: {
      matchedIngredientId: true,
      pricePerKgNormalized: true,
      previousPricePerKg: true,
      priceChangePercent: true,
      invoice: { select: { acceptedAt: true } },
      matchedIngredient: { select: { id: true, name: true } },
    },
    orderBy: { invoice: { acceptedAt: 'desc' } },
  })

  // Для каждого ingredient — первая (самая свежая) строка.
  const latestByIngredient = new Map<string, PriceGrowthRow>()
  for (const ln of lines) {
    const ing = ln.matchedIngredient
    if (!ing) continue
    if (latestByIngredient.has(ing.id)) continue
    const acceptedAt = ln.invoice.acceptedAt
    if (!acceptedAt) continue
    latestByIngredient.set(ing.id, {
      ingredientId: ing.id,
      name: ing.name,
      oldPrice: Number(ln.previousPricePerKg ?? 0),
      newPrice: Number(ln.pricePerKgNormalized ?? 0),
      changePercent: Number(ln.priceChangePercent ?? 0),
      acceptedAt,
    })
  }

  // Сортировка DESC по priceChangePercent — приоритет ингредиентам с самым
  // сильным РОСТОМ цены (это то, что нужно ADMIN_PRO видеть в первую очередь).
  return Array.from(latestByIngredient.values())
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, limit)
}

// ============================================================
// W3. Скрытая потеря маржи
// ============================================================

export type MarginLossWeekPoint = {
  week: string
  loss: number
}

export type MarginLossResult = {
  totalLoss: number
  byWeek: MarginLossWeekPoint[]
}

/**
 * Скрытая потеря маржи — деньги, переплаченные относительно min-цены за период.
 *
 * Формула (unit-safe, работает для KG/L/PCS равноценно):
 *   lossPerIngredient = (avgPrice - minPrice) / avgPrice × totalSpent
 *
 * Где:
 *   totalSpent = SUM(rawAmount по всем lines ингредиента в периоде) — деньги в ₽
 *   avgPrice   = weighted-by-amount (через нормализованное qty = rawAmount / price)
 *   minPrice   = MIN(pricePerKgNormalized)
 *
 * Почему НЕ через `quantity × Δprice`:
 *   - InvoiceLine.rawQuantity хранится в rawUnit (г / мл / шт / уп). Если строка
 *     в граммах, а pricePerKgNormalized в ₽/кг — qty × Δprice даёт результат
 *     в 1000 раз больше реального (off-by-1000).
 *   - rawAmount уже денежная величина в ₽, не зависит от unit-conversion.
 *   - (avg - min) / avg — безразмерная доля переплаты.
 *
 * PCS-ингредиенты включены: для них pricePerKgNormalized = цена за штуку,
 * формула остаётся корректной (avg и min — оба ₽/шт, доля переплаты безразмерна).
 *
 * byWeek — раскладка общей потери по ISO-неделям (MSK) пропорционально
 * rawAmount каждой строки в этой неделе.
 */
export async function getHiddenMarginLoss({
  from,
  to,
}: {
  from: Date
  to: Date
}): Promise<MarginLossResult> {
  const lines = await prisma.invoiceLine.findMany({
    where: {
      matchedIngredientId: { not: null },
      pricePerKgNormalized: { not: null },
      invoice: {
        status: 'ACCEPTED',
        acceptedAt: { gte: from, lte: to },
      },
    },
    select: {
      matchedIngredientId: true,
      rawAmount: true,
      pricePerKgNormalized: true,
      invoice: { select: { acceptedAt: true } },
    },
  })

  if (lines.length === 0) {
    return { totalLoss: 0, byWeek: [] }
  }

  type LineLite = { price: number; amount: number; week: string }

  const byIngredient = new Map<string, LineLite[]>()
  for (const ln of lines) {
    const ingId = ln.matchedIngredientId
    if (!ingId) continue
    const price = Number(ln.pricePerKgNormalized ?? 0)
    if (price <= 0) continue
    const amount = Number(ln.rawAmount ?? 0)
    if (amount <= 0) continue
    const acceptedAt = ln.invoice.acceptedAt
    if (!acceptedAt) continue
    const week = toIsoWeekKeyMsk(acceptedAt)
    const arr = byIngredient.get(ingId) ?? []
    arr.push({ price, amount, week })
    byIngredient.set(ingId, arr)
  }

  let totalLoss = 0
  const lossByWeek = new Map<string, number>()

  for (const arr of byIngredient.values()) {
    const totalSpent = arr.reduce((s, x) => s + x.amount, 0)
    if (totalSpent <= 0) continue
    // Нормализованный qty per line = amount / price (unit-safe: и amount, и price
    // привязаны к одной и той же физической единице ингредиента). totalNormalizedQty
    // — суммарный «вес» в нормализованных единицах (кг для KG, л для L, шт для PCS).
    const totalNormalizedQty = arr.reduce((s, x) => s + x.amount / x.price, 0)
    if (totalNormalizedQty <= 0) continue
    const avgPrice = totalSpent / totalNormalizedQty
    const minPrice = arr.reduce((m, x) => Math.min(m, x.price), arr[0].price)
    if (avgPrice <= minPrice) continue
    const lossForIngredient = ((avgPrice - minPrice) / avgPrice) * totalSpent
    totalLoss += lossForIngredient

    // Раскладка по неделям пропорционально rawAmount строки.
    for (const x of arr) {
      const share = x.amount / totalSpent
      const weekLoss = lossForIngredient * share
      lossByWeek.set(x.week, (lossByWeek.get(x.week) ?? 0) + weekLoss)
    }
  }

  const byWeek: MarginLossWeekPoint[] = Array.from(lossByWeek.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([week, loss]) => ({ week, loss: Math.round(loss * 100) / 100 }))

  return { totalLoss: Math.round(totalLoss * 100) / 100, byWeek }
}

// ============================================================
// W4. Динамика средней цены по группам (KG | L | PCS)
// ============================================================

export type GroupPriceTrendPoint = {
  week: string
  avgPrice: number
  count: number
}

/**
 * Усреднённая цена за единицу нормализованного веса/объёма по неделям
 * для указанной группы ингредиентов (по Ingredient.unit). Для PCS
 * нормализация цены = цена за штуку.
 */
export async function getGroupPriceTrend({
  from,
  to,
  group,
}: {
  from: Date
  to: Date
  group: IngredientUnit
}): Promise<GroupPriceTrendPoint[]> {
  const lines = await prisma.invoiceLine.findMany({
    where: {
      matchedIngredientId: { not: null },
      pricePerKgNormalized: { not: null },
      invoice: {
        status: 'ACCEPTED',
        acceptedAt: { gte: from, lte: to },
      },
      matchedIngredient: { unit: group },
    },
    select: {
      pricePerKgNormalized: true,
      invoice: { select: { acceptedAt: true } },
    },
  })

  if (lines.length === 0) return []

  const sumByWeek = new Map<string, { sum: number; count: number }>()
  for (const ln of lines) {
    const price = Number(ln.pricePerKgNormalized ?? 0)
    if (price <= 0) continue
    const acceptedAt = ln.invoice.acceptedAt
    if (!acceptedAt) continue
    const week = toIsoWeekKeyMsk(acceptedAt)
    const cur = sumByWeek.get(week) ?? { sum: 0, count: 0 }
    cur.sum += price
    cur.count += 1
    sumByWeek.set(week, cur)
  }

  return Array.from(sumByWeek.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([week, agg]) => ({
      week,
      avgPrice: Math.round((agg.sum / agg.count) * 100) / 100,
      count: agg.count,
    }))
}

// ============================================================
// Helpers
// ============================================================

/**
 * ISO-неделя в MSK-календаре. Возвращает ключ вида '2026-W21'.
 * Используем понедельник MSK-недели как точку, форматируем 'YYYY' + '-W' + 'II'.
 */
function toIsoWeekKeyMsk(date: Date): string {
  // Сдвигаемся в MSK-арифметике, чтобы понедельник был всегда корректный.
  const mskShifted = new Date(date.getTime() + MSK_OFFSET_MS)
  const y = mskShifted.getUTCFullYear()
  const m = mskShifted.getUTCMonth()
  const d = mskShifted.getUTCDate()
  const dow = mskShifted.getUTCDay() // 0=Sun..6=Sat в MSK
  const daysToMon = (dow + 6) % 7
  const mondayUtcMidnight = Date.UTC(y, m, d - daysToMon, 0, 0, 0, 0)
  const monday = new Date(mondayUtcMidnight - MSK_OFFSET_MS)
  // date-fns-tz форматирует в MSK; 'II' — ISO week, 'RRRR' — ISO week year.
  // (Прим.: используем большие буквы для ISO; см. unicode TR35.)
  // Fallback: вычислим вручную, если хочется детерминизма без date-fns.
  return formatInTimeZone(monday, MSK_TIMEZONE, "RRRR-'W'II")
}

/**
 * Количество ACCEPTED-накладных в периоде — для empty state.
 */
export async function countAcceptedInvoicesInRange({
  from,
  to,
}: {
  from: Date
  to: Date
}): Promise<number> {
  return prisma.invoice.count({
    where: {
      status: 'ACCEPTED',
      acceptedAt: { gte: from, lte: to },
    },
  })
}

// ============================================================
// Period resolver
// ============================================================

export type AnalyticsPeriod = 'week' | 'month' | 'quarter' | 'year'

export type ResolvedPeriod = {
  period: AnalyticsPeriod
  from: Date
  to: Date
  label: string
}

/**
 * Парсит ?period= из searchParams в календарный {from, to} в MSK.
 * Невалидные значения → fallback 'month'. Used by /analytics/invoices.
 *
 * Границы — календарные, не rolling:
 *   week    — ISO-неделя (Пн 00:00 МСК → Вс 23:59:59.999 МСК)
 *   month   — текущий календарный месяц (1-е 00:00 → последнее 23:59:59.999 МСК)
 *   quarter — текущий календарный квартал (янв-мар / апр-июн / июл-сен / окт-дек)
 *   year    — текущий календарный год (1 января → 31 декабря)
 *
 * MSK = UTC+3 без DST. Для месяц/квартал/год используем UTC-арифметику со
 * сдвигом на +3 часа (Date.UTC(...) − MSK_OFFSET_MS = MSK-полночь как UTC-точка).
 * Для week — переиспользуем getMondayOfWeek / getSundayOfWeek из utils/week.ts.
 */
export function resolvePeriod(period: string | undefined): ResolvedPeriod {
  const valid: AnalyticsPeriod[] = ['week', 'month', 'quarter', 'year']
  const p: AnalyticsPeriod = valid.includes(period as AnalyticsPeriod)
    ? (period as AnalyticsPeriod)
    : 'month'

  const now = new Date()
  // MSK-компоненты текущего момента.
  const mskNow = new Date(now.getTime() + MSK_OFFSET_MS)
  const year = mskNow.getUTCFullYear()
  const month = mskNow.getUTCMonth() // 0..11

  let from: Date
  let to: Date
  let label: string

  if (p === 'week') {
    from = getMondayOfWeek(now)
    to = getSundayOfWeek(now)
    label = `Эта неделя (${formatWeekShortMsk(from, to)})`
  } else if (p === 'month') {
    from = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - MSK_OFFSET_MS)
    to = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - MSK_OFFSET_MS)
    // "Май 2026" — capitalize первой буквы, locale ru.
    const raw = formatInTimeZone(from, MSK_TIMEZONE, 'LLLL yyyy', { locale: ru })
    label = raw.charAt(0).toUpperCase() + raw.slice(1)
  } else if (p === 'quarter') {
    const q = Math.floor(month / 3) // 0..3
    const qStartMonth = q * 3
    from = new Date(Date.UTC(year, qStartMonth, 1, 0, 0, 0, 0) - MSK_OFFSET_MS)
    to = new Date(Date.UTC(year, qStartMonth + 3, 0, 23, 59, 59, 999) - MSK_OFFSET_MS)
    const m1 = formatInTimeZone(from, MSK_TIMEZONE, 'LLL', { locale: ru })
    const m2 = formatInTimeZone(to, MSK_TIMEZONE, 'LLL', { locale: ru })
    label = `Q${q + 1} ${year} (${m1}–${m2})`
  } else {
    // year
    from = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0) - MSK_OFFSET_MS)
    to = new Date(Date.UTC(year, 12, 0, 23, 59, 59, 999) - MSK_OFFSET_MS)
    label = String(year)
  }

  return { period: p, from, to, label }
}

/**
 * "16–22 июня" — короткий диапазон недели без года, для label-чипа.
 * В одном месяце → "16–22 июня". На границе месяцев → "29 мая – 4 июня".
 */
function formatWeekShortMsk(monday: Date, sunday: Date): string {
  const mMonth = formatInTimeZone(monday, MSK_TIMEZONE, 'M')
  const sMonth = formatInTimeZone(sunday, MSK_TIMEZONE, 'M')
  if (mMonth === sMonth) {
    const d1 = formatInTimeZone(monday, MSK_TIMEZONE, 'd')
    const d2Month = formatInTimeZone(sunday, MSK_TIMEZONE, 'd MMMM', { locale: ru })
    return `${d1}–${d2Month}`
  }
  const d1Month = formatInTimeZone(monday, MSK_TIMEZONE, 'd MMM', { locale: ru })
  const d2Month = formatInTimeZone(sunday, MSK_TIMEZONE, 'd MMM', { locale: ru })
  return `${d1Month} – ${d2Month}`
}
