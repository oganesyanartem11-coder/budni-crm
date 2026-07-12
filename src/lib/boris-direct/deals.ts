/**
 * М5 ШАГ 2: dealStatus-петля (деньги на фразу).
 *
 * Владелец отмечает сделки в чате: «Борис, сделка <телефон> <сумма>» / «... отмена».
 * Борис находит лид в БД по телефону, ставит dealStatus/dealAmount, отвечает
 * подтверждением. Из сделок weekly считает ВЫРУЧКУ по фразам (utm_term) — фундамент
 * калибровки LEAD_VALUE (только ВЫВОД в отчёте, константу НЕ меняем).
 *
 * В решалку/биддинг выручка НЕ подключается — только видимость. Меняем ровно два
 * поля лида (dealStatus/dealAmount), новых таблиц/миграций нет.
 *
 * ЧИСТЫЕ функции (разбор/матч/агрегация) + тонкий prisma-I/O.
 */

import { prisma } from '@/lib/db/prisma'
import { isTestLead } from './test-markers'

// ---------- Разбор команды ----------

/** Разобранная команда сделки. */
export interface ParsedDealCommand {
  kind: 'set' | 'cancel' | 'invalid'
  identifierDigits: string
  amountRub?: number
  error?: string
}

const CANCEL_WORDS = new Set(['отмена', 'отменить', 'отмену', 'убери', 'снять'])

/** Только цифры из строки. */
function digitsOf(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/** '150000'|'150к'|'20тыс' → рубли (>0) или null. */
function parseAmount(token: string): number | null {
  const m = /^(\d+)(к|k|т|тыс)?$/i.exec(token.trim())
  if (!m) return null
  const base = Number(m[1])
  if (!Number.isFinite(base)) return null
  const amount = m[2] ? base * 1000 : base
  return amount > 0 ? amount : null
}

/**
 * Разбор команды сделки. Вход — текст ПОСЛЕ префикса «борис,», начинающийся с
 * «сделка» (см. telegram.handleDirectChatMessage). Идентификатор = всё до
 * последнего токена (телефон, нормализуется в цифры, ≥4). Последний токен —
 * «отмена»(cancel) или сумма(set). Иначе invalid с понятной ошибкой.
 */
export function parseDealCommand(command: string): ParsedDealCommand {
  const rest = command.replace(/^сделка\b/, '').trim()
  const tokens = rest.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) {
    return { kind: 'invalid', identifierDigits: '', error: 'нужно: «сделка <телефон> <сумма>» (или «... отмена»)' }
  }

  const last = tokens[tokens.length - 1]
  const identifierDigits = digitsOf(tokens.slice(0, -1).join(''))
  if (identifierDigits.length < 4) {
    return { kind: 'invalid', identifierDigits, error: 'не понял телефон (нужно ≥4 цифр — можно последние 4)' }
  }

  if (CANCEL_WORDS.has(last.toLowerCase())) {
    return { kind: 'cancel', identifierDigits }
  }

  const amountRub = parseAmount(last)
  if (amountRub == null) {
    return { kind: 'invalid', identifierDigits, error: 'не понял сумму (пример: 150000 или 150к)' }
  }
  return { kind: 'set', identifierDigits, amountRub }
}

// ---------- Поиск лида ----------

/** Лид-кандидат для сделки (поля из БД, без лишнего). */
export interface DealLeadCandidate {
  id: string
  phoneDigits: string | null
  phone?: string | null
  name: string | null
  createdAt: Date
  utmTerm?: string | null
}

/**
 * Находит лиды по идентификатору-телефону: точное или суффиксное совпадение
 * (последние N цифр). Тестовые лиды-маркеры исключаются (сделками не метим).
 * 0 → не найден; 1 → однозначно; >1 → неоднозначно (вызывающий спросит).
 */
export function findLeadMatches(
  identifierDigits: string,
  candidates: DealLeadCandidate[]
): DealLeadCandidate[] {
  return candidates.filter((c) => {
    if (isTestLead({ phoneDigits: c.phoneDigits, phone: c.phone, name: c.name })) return false
    const digits = c.phoneDigits && c.phoneDigits.trim() ? digitsOf(c.phoneDigits) : digitsOf(c.phone)
    return digits.length > 0 && digits.endsWith(identifierDigits)
  })
}

// ---------- Агрегация выручки ----------

/** Выигранная сделка для расчёта выручки. */
export interface WonDeal {
  utmTerm: string | null
  dealAmountRub: number
}

/** Выручка по одной фразе. */
export interface PhraseRevenue {
  query: string
  revenue: number
  deals: number
}

/** Свод выручки по фразам за период. */
export interface RevenueSummary {
  byPhrase: PhraseRevenue[]
  unattributedRevenue: number
  unattributedDeals: number
  totalRevenue: number
  dealCount: number
  avgCheckRub: number | null
}

/**
 * Агрегирует выручку сделок по фразам (utm_term — «лид→фраза» существующей
 * атрибуции). Лиды без utm_term → «без атрибуции». Средний чек = выручка/сделки.
 */
export function aggregateRevenueByPhrase(deals: WonDeal[]): RevenueSummary {
  const byPhrase = new Map<string, PhraseRevenue>()
  let unattributedRevenue = 0
  let unattributedDeals = 0
  let totalRevenue = 0

  for (const d of deals) {
    const amount = d.dealAmountRub
    totalRevenue += amount
    const term = d.utmTerm?.trim().toLowerCase() ?? ''
    if (!term) {
      unattributedRevenue += amount
      unattributedDeals += 1
      continue
    }
    const cur = byPhrase.get(term) ?? { query: term, revenue: 0, deals: 0 }
    cur.revenue += amount
    cur.deals += 1
    byPhrase.set(term, cur)
  }

  return {
    byPhrase: [...byPhrase.values()].sort((a, b) => b.revenue - a.revenue),
    unattributedRevenue,
    unattributedDeals,
    totalRevenue,
    dealCount: deals.length,
    avgCheckRub: deals.length > 0 ? totalRevenue / deals.length : null,
  }
}

// ---------- prisma I/O (тонкий слой) ----------

const DEAL_LOOKUP_WINDOW_DAYS = 180

/** Лиды-кандидаты за окно по суффиксу телефона (для матчинга сделки). */
export async function findRecentLeadCandidates(identifierDigits: string): Promise<DealLeadCandidate[]> {
  const from = new Date(Date.now() - DEAL_LOOKUP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const rows = await prisma.landingLead.findMany({
    where: { createdAt: { gte: from }, phoneDigits: { endsWith: identifierDigits } },
    select: { id: true, phoneDigits: true, phone: true, name: true, createdAt: true, utmTerm: true },
    orderBy: { createdAt: 'desc' },
  })
  return rows
}

/** Отметить сделку выигранной (dealStatus=WON, dealAmount). */
export async function markDealWon(leadId: string, amountRub: number): Promise<void> {
  await prisma.landingLead.update({
    where: { id: leadId },
    data: { dealStatus: 'WON', dealAmount: amountRub },
  })
}

/** Снять отметку сделки (dealStatus=NONE, dealAmount=null). */
export async function cancelDeal(leadId: string): Promise<void> {
  await prisma.landingLead.update({
    where: { id: leadId },
    data: { dealStatus: 'NONE', dealAmount: null },
  })
}

/** Выигранные сделки: за период (по дате лида) и всего. dealAmount в рублях. */
export async function getWonDeals(
  from: Date,
  to: Date
): Promise<{ inPeriod: WonDeal[]; all: WonDeal[] }> {
  const rows = await prisma.landingLead.findMany({
    where: { dealStatus: 'WON', dealAmount: { not: null } },
    select: { createdAt: true, utmTerm: true, dealAmount: true, phoneDigits: true, phone: true, name: true },
    orderBy: { createdAt: 'desc' },
  })
  const toDeal = (r: (typeof rows)[number]): WonDeal => ({
    utmTerm: r.utmTerm,
    dealAmountRub: Number(r.dealAmount ?? 0),
  })
  // Тест-лиды не считаем деньгами (как везде в экономике).
  const real = rows.filter((r) => !isTestLead({ phoneDigits: r.phoneDigits, phone: r.phone, name: r.name }))
  return {
    all: real.map(toDeal),
    inPeriod: real.filter((r) => r.createdAt >= from && r.createdAt <= to).map(toDeal),
  }
}
