/**
 * М5 ШАГ 2: dealStatus-петля (деньги на фразу). Тесты ЧИСТЫХ функций:
 * разбор команды владельца, поиск лида по телефону (однозначно/неоднозначно/
 * не найден), агрегация выручки по фразам. I/O prisma — в telegram-хендлере/route.
 */

import { describe, it, expect } from 'vitest'
import {
  parseDealCommand,
  findLeadMatches,
  aggregateRevenueByPhrase,
  type DealLeadCandidate,
  type WonDeal,
} from './deals'

describe('ШАГ 3 (спринт 16.07): «сделка» находит лид-ЗВОНОК по телефону', () => {
  it('phone_call-лид матчится по суффиксу телефона (formType не фильтруется)', () => {
    const callLead: DealLeadCandidate = {
      id: 'call1',
      phoneDigits: '79991234567',
      phone: '79991234567',
      name: null,
      createdAt: new Date('2026-07-16T08:28:00Z'),
      utmTerm: null, // звонок без атрибуции — сделка всё равно вешается
    }
    const formLead: DealLeadCandidate = { id: 'form1', phoneDigits: '79990009999', phone: '79990009999', name: null, createdAt: new Date() }
    expect(findLeadMatches('1234567', [callLead, formLead]).map((m) => m.id)).toEqual(['call1'])
  })
})

describe('parseDealCommand: «сделка <телефон> <сумма>» / «... отмена»', () => {
  it('телефон + сумма → set', () => {
    const r = parseDealCommand('сделка 79991234567 150000')
    expect(r.kind).toBe('set')
    expect(r.identifierDigits).toBe('79991234567')
    expect(r.amountRub).toBe(150000)
  })

  it('телефон с плюсом/скобками/дефисами → нормализует в цифры', () => {
    const r = parseDealCommand('сделка +7 (999) 123-45-67 150000')
    expect(r.kind).toBe('set')
    expect(r.identifierDigits).toBe('79991234567')
    expect(r.amountRub).toBe(150000)
  })

  it('сумма с суффиксом «к»/«т» = тысячи', () => {
    expect(parseDealCommand('сделка 4567 150к').amountRub).toBe(150000)
    expect(parseDealCommand('сделка 4567 150т').amountRub).toBe(150000)
    expect(parseDealCommand('сделка 4567 20тыс').amountRub).toBe(20000)
  })

  it('последние 4 цифры как идентификатор', () => {
    const r = parseDealCommand('сделка 4567 90000')
    expect(r.kind).toBe('set')
    expect(r.identifierDigits).toBe('4567')
  })

  it('«... отмена» → cancel', () => {
    const r = parseDealCommand('сделка 79991234567 отмена')
    expect(r.kind).toBe('cancel')
    expect(r.identifierDigits).toBe('79991234567')
  })

  it('слишком короткий идентификатор (<4 цифр) → invalid', () => {
    expect(parseDealCommand('сделка 12 5000').kind).toBe('invalid')
  })

  it('нет суммы → invalid', () => {
    expect(parseDealCommand('сделка 79991234567').kind).toBe('invalid')
  })

  it('нулевая/отрицательная сумма → invalid', () => {
    expect(parseDealCommand('сделка 4567 0').kind).toBe('invalid')
    expect(parseDealCommand('сделка 4567 -5').kind).toBe('invalid')
  })

  it('сумма не число → invalid', () => {
    expect(parseDealCommand('сделка 4567 много').kind).toBe('invalid')
  })
})

describe('findLeadMatches: телефон → лид(ы)', () => {
  const leads: DealLeadCandidate[] = [
    { id: 'a', phoneDigits: '79991234567', name: 'Иван', createdAt: new Date('2026-07-10'), utmTerm: 'обеды в офис' },
    { id: 'b', phoneDigits: '79997654321', name: 'Пётр', createdAt: new Date('2026-07-11'), utmTerm: 'доставка обедов' },
    { id: 'c', phoneDigits: '79991234567', name: 'Дубль', createdAt: new Date('2026-07-09'), utmTerm: null },
  ]

  it('полный телефон, один лид → однозначно', () => {
    const m = findLeadMatches('79997654321', leads)
    expect(m).toHaveLength(1)
    expect(m[0].id).toBe('b')
  })

  it('полный телефон, два лида → неоднозначно (список)', () => {
    const m = findLeadMatches('79991234567', leads)
    expect(m).toHaveLength(2)
  })

  it('последние 4 цифры (суффикс) → матч', () => {
    const m = findLeadMatches('4321', leads)
    expect(m).toHaveLength(1)
    expect(m[0].id).toBe('b')
  })

  it('не найден → пусто', () => {
    expect(findLeadMatches('0000', leads)).toHaveLength(0)
  })

  it('тестовые лиды-маркеры исключаются', () => {
    const withTest: DealLeadCandidate[] = [
      { id: 't', phoneDigits: '79995555555', name: 'Тестик', createdAt: new Date('2026-07-10'), utmTerm: null },
    ]
    expect(findLeadMatches('79995555555', withTest)).toHaveLength(0)
  })
})

describe('aggregateRevenueByPhrase: выручка по фразам + средний чек', () => {
  const deals: WonDeal[] = [
    { utmTerm: 'обеды в офис', dealAmountRub: 100000 },
    { utmTerm: 'обеды в офис', dealAmountRub: 50000 },
    { utmTerm: 'доставка обедов', dealAmountRub: 30000 },
    { utmTerm: null, dealAmountRub: 20000 }, // без атрибуции
  ]

  it('группирует по фразе (utm_term), считает суммарно и средний чек', () => {
    const s = aggregateRevenueByPhrase(deals)
    expect(s.totalRevenue).toBe(200000)
    expect(s.dealCount).toBe(4)
    expect(s.avgCheckRub).toBe(50000)
    const office = s.byPhrase.find((p) => p.query === 'обеды в офис')
    expect(office?.revenue).toBe(150000)
    expect(office?.deals).toBe(2)
  })

  it('фразы отсортированы по выручке убыванием', () => {
    const s = aggregateRevenueByPhrase(deals)
    expect(s.byPhrase[0].query).toBe('обеды в офис')
  })

  it('лиды без utm_term → в «без атрибуции»', () => {
    const s = aggregateRevenueByPhrase(deals)
    expect(s.unattributedRevenue).toBe(20000)
    expect(s.unattributedDeals).toBe(1)
  })

  it('нет сделок → нули, средний чек null', () => {
    const s = aggregateRevenueByPhrase([])
    expect(s.totalRevenue).toBe(0)
    expect(s.dealCount).toBe(0)
    expect(s.avgCheckRub).toBeNull()
    expect(s.byPhrase).toEqual([])
  })
})
