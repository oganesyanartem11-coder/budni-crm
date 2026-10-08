import { describe, expect, it, vi } from 'vitest'

const { mockParseChangeIntent } = vi.hoisted(() => ({ mockParseChangeIntent: vi.fn() }))
vi.mock('./parse-change-intent', () => ({ parseChangeIntent: mockParseChangeIntent }))

import { extractDateDeterministic, extractDeliveryDateFromText } from './extract-delivery-date'

// чт 8 окт 2026, 10:41 МСК — как у «Промышленной тары».
const THU = new Date('2026-10-08T07:41:00.000Z')

describe('extractDateDeterministic (баг 08.10, «Промышленная тара»)', () => {
  it.each([
    ['Здравствуйте! На завтра 7 обедов', '2026-10-09'],
    ['На пятницу 7, а не на сегодня!', '2026-10-09'],
    ['не на сегодня, а на завтра 7', '2026-10-09'],
    ['сегодня 5', '2026-10-08'],
    ['послезавтра 10', '2026-10-10'],
    ['на понедельник 12', '2026-10-12'],
    ['в пн 12', '2026-10-12'],
    ['на среду 3', '2026-10-14'],
    ['на 9.10 — 7', '2026-10-09'],
    ['12/10 по 20', '2026-10-12'],
    ['на 9 октября 7 обедов', '2026-10-09'],
    ['на 15-е 20', '2026-10-15'],
    ['на 2-е 20', '2026-11-02'],
    ['5 января 10', '2027-01-05'],
  ])('%s → %s', (text, expected) => {
    expect(extractDateDeterministic(text, THU)).toBe(expected)
  })

  it.each(['7 обедов', 'Обед 75, завтрак и ужин 45', 'нас будет 12', 'средний 5', 'к 12.30 привезите 5'])(
    'без даты: %s',
    (text) => {
      expect(extractDateDeterministic(text, THU)).toBeNull()
    },
  )

  it('две разные даты → ambiguous', () => {
    expect(extractDateDeterministic('завтра 7 и в понедельник 9', THU)).toBe('ambiguous')
  })
})

describe('extractDeliveryDateFromText', () => {
  it('«На завтра 7 обедов» → 09.10 без LLM', async () => {
    expect(await extractDeliveryDateFromText('Здравствуйте! На завтра 7 обедов', THU)).toEqual(
      new Date('2026-10-09T00:00:00.000Z'),
    )
    expect(mockParseChangeIntent).not.toHaveBeenCalled()
  })

  it('несколько дат → LLM, с разрешёнными приёмами пищи', async () => {
    mockParseChangeIntent.mockResolvedValue({ action: 'CHANGE', date: '2026-10-12', dateTo: null })
    expect(await extractDeliveryDateFromText('завтра 7 и в понедельник 9', THU)).toEqual(
      new Date('2026-10-12T00:00:00.000Z'),
    )
    expect(mockParseChangeIntent.mock.calls[0][1].availableMealTypes).toEqual(['ЗАВТРАК', 'ОБЕД', 'УЖИН'])
  })
})
