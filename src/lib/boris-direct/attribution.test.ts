import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Атрибуция заявок: чистые функции проверяем напрямую, prisma мокаем —
 * тесты без живой БД и без сети.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    landingLead: { findMany: vi.fn() },
  },
}))

vi.mock('@/lib/db/prisma', () => ({ prisma: mockPrisma }))

import {
  type LeadForAttribution,
  getLeadsForPeriod,
  splitLeadsByOrigin,
  toQueryStatRow,
  matchLeadsToTerms,
  computeCostPerLead,
  type QueryStatRow,
} from './attribution'

/** Лид-заготовка: все поля пустые, нужное переопределяем в тесте. */
function makeLead(overrides: Partial<LeadForAttribution> = {}): LeadForAttribution {
  return {
    id: 'lead_1',
    createdAt: new Date('2026-06-15T12:00:00Z'),
    yclid: null,
    gclid: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    source: null,
    phoneDigits: null,
    ...overrides,
  }
}

function makeRow(overrides: Partial<QueryStatRow> = {}): QueryStatRow {
  return {
    query: 'доставка еды в офис',
    adGroupName: 'G1',
    adGroupId: '5769314414',
    impressions: 100,
    clicks: 10,
    costRub: 1500,
    conversions: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getLeadsForPeriod', () => {
  it('findMany по createdAt gte/lte, select нужных полей, orderBy createdAt asc', async () => {
    const from = new Date('2026-06-01T00:00:00Z')
    const to = new Date('2026-06-30T23:59:59Z')
    const lead = makeLead({ id: 'lead_db' })
    mockPrisma.landingLead.findMany.mockResolvedValue([lead])

    const result = await getLeadsForPeriod(from, to)

    expect(result).toEqual([lead])
    expect(mockPrisma.landingLead.findMany).toHaveBeenCalledTimes(1)
    const args = mockPrisma.landingLead.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ createdAt: { gte: from, lte: to } })
    expect(args.orderBy).toEqual({ createdAt: 'asc' })
    expect(args.select).toMatchObject({
      id: true,
      createdAt: true,
      yclid: true,
      gclid: true,
      utmSource: true,
      utmMedium: true,
      utmTerm: true,
      source: true,
      phoneDigits: true,
    })
    // Телефон целиком и другие лишние поля не выбираем.
    expect(args.select.phone).toBeUndefined()
  })
})

describe('splitLeadsByOrigin', () => {
  it('yclid непустой → fromDirect (даже без UTM)', () => {
    const lead = makeLead({ yclid: '123456789' })
    const split = splitLeadsByOrigin([lead])
    expect(split.fromDirect).toEqual([lead])
    expect(split.fromOther).toEqual([])
    expect(split.unattributed).toEqual([])
  })

  it('utm_source из набора Директа → fromDirect, без учёта регистра', () => {
    for (const src of ['yandex', 'Direct', 'YANDEX-DIRECT', 'yandex_direct']) {
      const split = splitLeadsByOrigin([makeLead({ utmSource: src })])
      expect(split.fromDirect).toHaveLength(1)
    }
  })

  it("utm_medium=cpc + utm_source содержит 'yandex' → fromDirect", () => {
    const lead = makeLead({ utmSource: 'yandex.ru', utmMedium: 'CPC' })
    expect(splitLeadsByOrigin([lead]).fromDirect).toEqual([lead])
  })

  it('gclid или чужой utm_source → fromOther', () => {
    const google = makeLead({ id: 'g', gclid: 'gclid-abc' })
    const vk = makeLead({ id: 'vk', utmSource: 'vk', utmMedium: 'cpc' })
    const split = splitLeadsByOrigin([google, vk])
    expect(split.fromOther.map((l) => l.id)).toEqual(['g', 'vk'])
    expect(split.fromDirect).toEqual([])
  })

  it('совсем без меток → unattributed; пустые строки метками не считаются', () => {
    const bare = makeLead({ id: 'bare' })
    const blank = makeLead({ id: 'blank', yclid: '  ', utmSource: '' })
    const split = splitLeadsByOrigin([bare, blank])
    expect(split.unattributed.map((l) => l.id)).toEqual(['bare', 'blank'])
  })
})

describe('toQueryStatRow', () => {
  it('раскладывает поля TSV и приводит числа', () => {
    const row = toQueryStatRow({
      Query: 'обеды в офис москва',
      AdGroupName: 'G2',
      AdGroupId: '5769314415',
      Impressions: '250',
      Clicks: '12',
      Cost: '843.50',
      Conversions: '2',
    })
    expect(row).toEqual({
      query: 'обеды в офис москва',
      adGroupName: 'G2',
      adGroupId: '5769314415',
      impressions: 250,
      clicks: 12,
      costRub: 843.5,
      conversions: 2,
    })
  })

  it("Conversions '--' → 0 (и пустые числовые ячейки тоже)", () => {
    const row = toQueryStatRow({
      Query: 'q',
      AdGroupName: 'G1',
      AdGroupId: '1',
      Impressions: '--',
      Clicks: '',
      Cost: '--',
      Conversions: '--',
    })
    expect(row.conversions).toBe(0)
    expect(row.impressions).toBe(0)
    expect(row.clicks).toBe(0)
    expect(row.costRub).toBe(0)
  })
})

describe('matchLeadsToTerms', () => {
  it("utm_term совпадает с query (нормализация lower/trim) → matchedBy 'utm_term'", () => {
    const lead = makeLead({ yclid: 'y1', utmTerm: '  Доставка Еды В Офис ' })
    const rows = [makeRow({ query: 'доставка еды в офис' })]

    const [match] = matchLeadsToTerms([lead], rows)

    expect(match.matchedBy).toBe('utm_term')
    expect(match.matchedQuery).toBe('доставка еды в офис')
    expect(match.lead).toBe(lead)
  })

  it("нет совпадения или нет utm_term → matchedBy 'none', matchedQuery null", () => {
    const noTerm = makeLead({ id: 'no-term', yclid: 'y1' })
    const wrongTerm = makeLead({ id: 'wrong', yclid: 'y2', utmTerm: 'корпоративное питание' })
    const rows = [makeRow({ query: 'доставка еды в офис' })]

    const results = matchLeadsToTerms([noTerm, wrongTerm], rows)

    for (const r of results) {
      expect(r.matchedBy).toBe('none')
      expect(r.matchedQuery).toBeNull()
    }
  })
})

describe('computeCostPerLead', () => {
  it('делит расход на число заявок', () => {
    expect(computeCostPerLead(3000, 4)).toBe(750)
  })

  it('0 заявок → null (не Infinity, не деление на ноль)', () => {
    expect(computeCostPerLead(3000, 0)).toBeNull()
  })

  it('0 расхода при наличии заявок → 0', () => {
    expect(computeCostPerLead(0, 3)).toBe(0)
  })
})
