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
  dedupeLeadsByPhone,
  filterOutCallLeads,
  toQueryStatRow,
  matchLeadsToTerms,
  computeCostPerLead,
  type QueryStatRow,
} from './attribution'
import { CALL_FORM_TYPE } from './config'

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
    name: null,
    formType: 'popup',
    ...overrides,
  }
}

describe('гардрейлы звонков (спринт 16.07)', () => {
  it('phone_call НЕ Директ: нет yclid/cpc → не в fromDirect (не в CPA-знаменателе)', () => {
    const call = makeLead({ formType: CALL_FORM_TYPE, yclid: null, utmSource: null, utmMedium: null, phoneDigits: '79990001122' })
    const split = splitLeadsByOrigin([call])
    expect(split.fromDirect).toHaveLength(0)
  })

  it('filterOutCallLeads убирает phone_call, формы (popup/quiz/null) оставляет', () => {
    const leads = [
      makeLead({ id: 'form1', formType: 'popup' }),
      makeLead({ id: 'call1', formType: CALL_FORM_TYPE }),
      makeLead({ id: 'quiz1', formType: 'quiz' }),
      makeLead({ id: 'nullft', formType: null }),
    ]
    expect(filterOutCallLeads(leads).map((l) => l.id)).toEqual(['form1', 'quiz1', 'nullft'])
  })

  it('звонок с yclid-подобным мусором в utm всё равно не Директ, если yclid пуст и medium≠cpc', () => {
    const call = makeLead({ formType: CALL_FORM_TYPE, utmSource: 'yandex', utmMedium: null })
    expect(splitLeadsByOrigin([call]).fromDirect).toHaveLength(0)
  })
})

function makeRow(overrides: Partial<QueryStatRow> = {}): QueryStatRow {
  return {
    query: 'доставка еды в офис',
    adGroupName: 'G1',
    adGroupId: '5769314414',
    criterionId: null,
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

  it('exclusiveTo:true → верхняя граница lt (пограничный лид ровно на границе не двоится)', async () => {
    const from = new Date('2026-07-05T21:00:00Z')
    const to = new Date('2026-07-12T21:00:00Z')
    mockPrisma.landingLead.findMany.mockResolvedValue([])
    await getLeadsForPeriod(from, to, { exclusiveTo: true })
    const args = mockPrisma.landingLead.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ createdAt: { gte: from, lt: to } })
  })
})

describe('dedupeLeadsByPhone', () => {
  it('одинаковый номер в окне → один (первый по порядку), нормализация цифр', () => {
    const a = makeLead({ id: 'a', phoneDigits: '79991112233' })
    const b = makeLead({ id: 'b', phoneDigits: '7 (999) 111-22-33' })
    expect(dedupeLeadsByPhone([a, b]).map((l) => l.id)).toEqual(['a'])
  })

  it('разные номера → все остаются', () => {
    const a = makeLead({ id: 'a', phoneDigits: '79990000001' })
    const b = makeLead({ id: 'b', phoneDigits: '79990000002' })
    expect(dedupeLeadsByPhone([a, b]).map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('пустой/нулевой номер не дедупится (каждый уникален)', () => {
    const a = makeLead({ id: 'a', phoneDigits: null })
    const b = makeLead({ id: 'b', phoneDigits: '' })
    expect(dedupeLeadsByPhone([a, b]).map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('регресс 13.07: 4 рекламных лида (3 yclid + 1 cpc-без-yclid, разные номера) → delivered=4', () => {
    const leads = [
      makeLead({ id: 'L2', yclid: '3194', utmSource: 'yandex', utmMedium: 'cpc', phoneDigits: '79990000017' }),
      makeLead({ id: 'L3', yclid: null, utmSource: 'yandex', utmMedium: 'cpc', phoneDigits: '79990002004' }),
      makeLead({ id: 'L4', yclid: '9108', utmSource: 'yandex', utmMedium: 'cpc', phoneDigits: '79990005797' }),
      makeLead({ id: 'L5', yclid: '2521', utmSource: 'yandex', utmMedium: 'cpc', phoneDigits: '79990004779' }),
    ]
    const deduped = dedupeLeadsByPhone(leads)
    expect(splitLeadsByOrigin(deduped).fromDirect).toHaveLength(4)
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

  it('голый utm_source=yandex БЕЗ medium=cpc → НЕ fromDirect (органика/Карты/Бизнес) → fromOther', () => {
    for (const src of ['yandex', 'Direct', 'YANDEX-DIRECT', 'yandex_direct']) {
      const split = splitLeadsByOrigin([makeLead({ utmSource: src })])
      expect(split.fromDirect).toHaveLength(0)
      expect(split.fromOther).toHaveLength(1)
    }
  })

  it("utm_medium=cpc + utm_source содержит 'yandex' → fromDirect", () => {
    const lead = makeLead({ utmSource: 'yandex.ru', utmMedium: 'CPC' })
    expect(splitLeadsByOrigin([lead]).fromDirect).toEqual([lead])
  })

  it('cpc-лид yandex БЕЗ yclid (yclid потерян, utm сохранился) → fromDirect (кейс #3 13.07)', () => {
    const lead = makeLead({ utmSource: 'yandex', utmMedium: 'cpc' }) // yclid=null
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
      criterionId: null,
      impressions: 250,
      clicks: 12,
      costRub: 843.5,
      conversions: 2,
    })
  })

  it('CriterionId (id ключа) читается числом — для агрегации экономики по ключу', () => {
    const row = toQueryStatRow({
      Query: 'обеды в офис москва подешевле',
      AdGroupId: '5769314415',
      CriterionId: '57580142615',
      Clicks: '3',
      Conversions_575665118_LSCCD: '1',
    })
    // Запрос длиннее текста ключа (broad match) — но привязка к ключу по ID.
    expect(row.criterionId).toBe(57580142615)
    expect(row.query).toBe('обеды в офис москва подешевле')
    expect(row.conversions).toBe(1)
  })

  it('CriterionId пустой / нечисловой (напр. автотаргет) → criterionId=null (в экономику не идёт)', () => {
    expect(toQueryStatRow({ Query: 'q', CriterionId: '' }).criterionId).toBeNull()
    expect(toQueryStatRow({ Query: 'q', CriterionId: '--' }).criterionId).toBeNull()
    expect(toQueryStatRow({ Query: 'q' }).criterionId).toBeNull()
    expect(toQueryStatRow({ Query: 'q', CriterionId: '---autotargeting' }).criterionId).toBeNull()
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

  it('ШАГ 5: конверсии из суффиксной колонки Conversions_<goalId>_LSCCD (Goals в отчёте)', () => {
    // Реальный формат прода: голой Conversions НЕТ, есть суффиксная колонка цели.
    const row = toQueryStatRow({
      Query: 'бизнес ланч доставка москва',
      AdGroupName: 'G1',
      AdGroupId: '5769314414',
      Impressions: '2',
      Clicks: '1',
      Cost: '603.65',
      Conversions_575665118_LSCCD: '1',
    })
    expect(row.conversions).toBe(1)
  })

  it('ШАГ 5: суффиксная колонка цели приоритетнее голой Conversions', () => {
    const row = toQueryStatRow({
      Query: 'q',
      Conversions: '0',
      Conversions_575665118_LSCCD: '3',
    })
    expect(row.conversions).toBe(3)
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
