// Атрибуция заявок лендинга к Директу: «какая фраза/группа дала заявку».
//
// Чистые функции + один prisma-fetch. Точная связка фраза↔заявка достижима
// только через yclid → Метрика → визит — это следующая итерация; здесь
// сверяем по yclid/UTM-меткам и utm_term против отчёта по поисковым запросам.

import { prisma } from '@/lib/db/prisma'

// ---------- Лиды за период ----------

/** Поля LandingLead, нужные для атрибуции (ничего лишнего — без телефона целиком). */
export interface LeadForAttribution {
  id: string
  createdAt: Date
  yclid: string | null
  gclid: string | null
  utmSource: string | null
  /** Нужен для правила «medium=cpc + source содержит yandex» в splitLeadsByOrigin. */
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  source: string | null
  phoneDigits: string | null
}

/** Лиды за период по createdAt, старые первыми. */
export async function getLeadsForPeriod(from: Date, to: Date): Promise<LeadForAttribution[]> {
  return prisma.landingLead.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: {
      id: true,
      createdAt: true,
      yclid: true,
      gclid: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      utmTerm: true,
      source: true,
      phoneDigits: true,
    },
    orderBy: { createdAt: 'asc' },
  })
}

// ---------- Разбивка по происхождению ----------

export interface LeadSplit {
  fromDirect: LeadForAttribution[]
  fromOther: LeadForAttribution[]
  unattributed: LeadForAttribution[]
}

/** utm_source, однозначно означающие Яндекс.Директ (сравнение без регистра). */
const DIRECT_UTM_SOURCES = new Set(['yandex', 'direct', 'yandex-direct', 'yandex_direct'])

/** Признаки Директа: yclid; известный utm_source; medium=cpc + source с 'yandex'. */
function isFromDirect(lead: LeadForAttribution): boolean {
  if (lead.yclid && lead.yclid.trim() !== '') return true

  const source = lead.utmSource?.trim().toLowerCase() ?? ''
  if (source && DIRECT_UTM_SOURCES.has(source)) return true

  const medium = lead.utmMedium?.trim().toLowerCase() ?? ''
  if (medium === 'cpc' && source.includes('yandex')) return true

  return false
}

/**
 * Делит лиды: Директ / другой платный-меченый трафик / вообще без меток.
 * Чистая функция — порядок внутри групп сохраняется как во входе.
 */
export function splitLeadsByOrigin(leads: LeadForAttribution[]): LeadSplit {
  const split: LeadSplit = { fromDirect: [], fromOther: [], unattributed: [] }

  for (const lead of leads) {
    if (isFromDirect(lead)) {
      split.fromDirect.push(lead)
    } else if ((lead.gclid && lead.gclid.trim() !== '') || (lead.utmSource && lead.utmSource.trim() !== '')) {
      split.fromOther.push(lead)
    } else {
      split.unattributed.push(lead)
    }
  }

  return split
}

// ---------- Связка с отчётом Директа по поисковым запросам ----------

/** Строка отчёта Директа по запросам (уже приведённая к числам). */
export interface QueryStatRow {
  query: string
  adGroupName: string
  adGroupId: string
  impressions: number
  clicks: number
  costRub: number
  conversions: number
}

/** Число из ячейки TSV Директа: '--', пустота и мусор → 0. */
function tsvNumber(raw: string | undefined): number {
  const v = raw?.trim()
  if (!v || v === '--') return 0
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/**
 * Строка TSV-отчёта Директа (поля Query, AdGroupName, AdGroupId, Impressions,
 * Clicks, Cost, Conversions) → QueryStatRow. Conversions '--' означает 0.
 */
export function toQueryStatRow(raw: Record<string, string>): QueryStatRow {
  return {
    query: raw.Query ?? '',
    adGroupName: raw.AdGroupName ?? '',
    adGroupId: raw.AdGroupId ?? '',
    impressions: tsvNumber(raw.Impressions),
    clicks: tsvNumber(raw.Clicks),
    costRub: tsvNumber(raw.Cost),
    conversions: tsvNumber(raw.Conversions),
  }
}

/**
 * Сопоставляет лиды из Директа с поисковыми запросами по utm_term
 * (нормализация: trim + lower). Точное фраза↔заявка через yclid→Метрику —
 * следующая итерация, здесь только честное 'utm_term' | 'none'.
 */
export function matchLeadsToTerms(
  directLeads: LeadForAttribution[],
  rows: QueryStatRow[]
): Array<{ lead: LeadForAttribution; matchedQuery: string | null; matchedBy: 'utm_term' | 'none' }> {
  // Нормализованный запрос → оригинальный текст (первое вхождение).
  const queryByNorm = new Map<string, string>()
  for (const row of rows) {
    const norm = row.query.trim().toLowerCase()
    if (norm && !queryByNorm.has(norm)) queryByNorm.set(norm, row.query)
  }

  return directLeads.map((lead) => {
    const term = lead.utmTerm?.trim().toLowerCase() ?? ''
    const matched = term ? queryByNorm.get(term) : undefined
    return matched !== undefined
      ? { lead, matchedQuery: matched, matchedBy: 'utm_term' as const }
      : { lead, matchedQuery: null, matchedBy: 'none' as const }
  })
}

// ---------- Цена заявки ----------

/** Цена заявки в рублях; при 0 заявок — null (не Infinity, не деление на ноль). */
export function computeCostPerLead(costRub: number, leadsCount: number): number | null {
  if (leadsCount <= 0) return null
  return costRub / leadsCount
}
