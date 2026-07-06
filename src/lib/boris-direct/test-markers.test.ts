import { describe, it, expect } from 'vitest'
import { isTestLead, filterOutTestLeads, TEST_PHONE_DIGITS, TEST_NAMES } from './test-markers'

describe('isTestLead — маркеры тестов', () => {
  it('тестовый номер +79995555555 (в любом формате) → тест', () => {
    expect(isTestLead({ phoneDigits: '79995555555' })).toBe(true)
    expect(isTestLead({ phone: '+7 (999) 555-55-55' })).toBe(true)
    expect(isTestLead({ phoneDigits: null, phone: '8 999 555 55 55'.replace('8', '7') })).toBe(true)
  })

  it('имя «Тестик» (регистр/ё не важны) → тест', () => {
    expect(isTestLead({ name: 'Тестик' })).toBe(true)
    expect(isTestLead({ name: '  тестик ' })).toBe(true)
  })

  it('реальная заявка → не тест', () => {
    expect(isTestLead({ phoneDigits: '79161234567', name: 'Артём' })).toBe(false)
    expect(isTestLead({})).toBe(false)
    expect(isTestLead({ phone: null, name: null })).toBe(false)
  })

  it('маркеры заданы и расширяемы', () => {
    expect(TEST_PHONE_DIGITS).toContain('79995555555')
    expect(TEST_NAMES).toContain('тестик')
  })
})

describe('filterOutTestLeads', () => {
  it('убирает тесты, сохраняет реальные и порядок', () => {
    const leads = [
      { id: 'a', phoneDigits: '79161111111', name: 'Иван' },
      { id: 'b', phoneDigits: '79995555555', name: null },
      { id: 'c', name: 'Тестик' },
      { id: 'd', phoneDigits: '79162222222', name: null },
    ]
    const kept = filterOutTestLeads(leads)
    expect(kept.map((l) => l.id)).toEqual(['a', 'd'])
  })
})
