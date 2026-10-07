import { describe, expect, it } from 'vitest'
import type { ParseResult } from './parser'
import {
  classifyWeeklyItems,
  formatWeeklyDate,
  mondayOf,
  parseItemDate,
  type WeeklyConfigOption,
} from './sanity-checks'

/**
 * Построчный разбор недельной заявки. Сейчас — понедельник 5 окт 2026,
 * 10:00 МСК (07:00Z). Обычная точка: cut-off 16:00 МСК накануне.
 */
const NOW = new Date('2026-10-05T07:00:00.000Z')

const OFFICE: WeeklyConfigOption = {
  configId: 'cfg_office',
  locationId: 'loc_office',
  locationName: 'Офис',
  mealType: 'LUNCH',
  pricePerPortion: 300,
  location: { sameDayDelivery: false, isActive: true, cutoffHourMsk: null, cutoffMinuteMsk: null },
}
const WAREHOUSE: WeeklyConfigOption = {
  ...OFFICE,
  configId: 'cfg_wh',
  locationId: 'loc_wh',
  locationName: 'Склад',
}

function parsed(items: ParseResult['items'], confidence = 0.9): ParseResult {
  return { items, dietaryNotes: null, confidence, reason: 'ok' }
}

describe('classifyWeeklyItems', () => {
  it('чистая заявка с confidence 0.85 → автоприменение', () => {
    const r = classifyWeeklyItems(
      parsed(
        [
          { date: '2026-10-06', portions: 30 },
          { date: '2026-10-07', portions: 32 },
        ],
        0.85,
      ),
      [OFFICE],
      NOW,
    )
    expect(r.autoApply).toBe(true)
    expect(r.reviewReasons).toEqual([])
    expect(r.lines.map((l) => l.status)).toEqual(['ok', 'ok'])
    expect(r.lines[0].deliveryDate).toEqual(new Date('2026-10-06T00:00:00.000Z'))
    expect(r.lines[0].config?.configId).toBe('cfg_office')
  })

  it('confidence 0.7 → ручная проверка с причиной', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-06', portions: 30 }], 0.7), [OFFICE], NOW)
    expect(r.autoApply).toBe(false)
    expect(r.reviewReasons[0]).toContain('не уверен, что правильно понял')
    // строка сама по себе чистая — менеджер сможет «Внести как распознано»
    expect(r.lines[0].status).toBe('ok')
  })

  it('заявка в понедельник на текущую неделю: сегодня пропущено, вт–пт применяются автоматически', () => {
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-10-05', portions: 30 },
        { date: '2026-10-06', portions: 31 },
        { date: '2026-10-09', portions: 28 },
      ]),
      [OFFICE],
      NOW,
    )
    expect(r.lines.map((l) => [l.date, l.status])).toEqual([
      ['2026-10-05', 'skip'],
      ['2026-10-06', 'ok'],
      ['2026-10-09', 'ok'],
    ])
    expect(r.lines[0].note).toBe('приём на эту дату уже закрыт')
    expect(r.autoApply).toBe(true)
  })

  it('после 16:00 МСК завтрашний день уже закрыт по cut-off', () => {
    const evening = new Date('2026-10-05T13:30:00.000Z') // 16:30 МСК
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-10-06', portions: 31 },
        { date: '2026-10-07', portions: 30 },
      ]),
      [OFFICE],
      evening,
    )
    expect(r.lines.map((l) => l.status)).toEqual(['skip', 'ok'])
  })

  it('same-day точка: сегодня можно до её cut-off', () => {
    const sameDay: WeeklyConfigOption = {
      ...OFFICE,
      location: { sameDayDelivery: true, isActive: true, cutoffHourMsk: 11, cutoffMinuteMsk: 0 },
    }
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-05', portions: 20 }]), [sameDay], NOW)
    expect(r.lines[0].status).toBe('ok')
  })

  it('прошедшая дата и дата дальше 14 дней — пропуск с пометкой, остальное применяется', () => {
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-10-02', portions: 30 },
        { date: '2026-10-07', portions: 30 },
        { date: '2026-10-25', portions: 30 },
      ]),
      [OFFICE],
      NOW,
    )
    expect(r.lines.map((l) => [l.status, l.note])).toEqual([
      ['skip', 'дата уже прошла'],
      ['ok', null],
      ['skip', 'дальше 14 дней'],
    ])
    expect(r.autoApply).toBe(true)
  })

  it('все даты нередактируемые → ручная проверка «нет дат»', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-01', portions: 30 }]), [OFFICE], NOW)
    expect(r.autoApply).toBe(false)
    expect(r.reviewReasons).toContain('ни один день уже нельзя внести')
  })

  it('две точки без locationId → строка неоднозначна, не автомат', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-06', portions: 30 }]), [OFFICE, WAREHOUSE], NOW)
    expect(r.lines[0].status).toBe('blocked')
    expect(r.lines[0].note).toBe('непонятно, на какую точку')
    expect(r.autoApply).toBe(false)
  })

  it('две точки с locationId → однозначно, автомат', () => {
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-10-06', portions: 30, locationId: 'loc_office' },
        { date: '2026-10-06', portions: 12, locationId: 'loc_wh' },
      ]),
      [OFFICE, WAREHOUSE],
      NOW,
    )
    expect(r.lines.map((l) => l.config?.locationName)).toEqual(['Офис', 'Склад'])
    expect(r.autoApply).toBe(true)
  })

  it('невалидная дата, дробное число, дубль и нет цены — blocked', () => {
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-02-30', portions: 30 },
        { date: '2026-10-06', portions: 2.5 },
        { date: '2026-10-07', portions: 30 },
        { date: '2026-10-07', portions: 31 },
      ]),
      [OFFICE],
      NOW,
    )
    expect(r.lines.map((l) => l.status)).toEqual(['blocked', 'blocked', 'ok', 'blocked'])
    expect(r.lines[3].note).toBe('дата повторяется')

    const noPrice = classifyWeeklyItems(
      parsed([{ date: '2026-10-06', portions: 30 }]),
      [{ ...OFFICE, pricePerPortion: 0 }],
      NOW,
    )
    expect(noPrice.lines[0].note).toBe('у питания не задана цена')
  })

  it('0 порций — валидная строка («не нужно» → отмена при применении)', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-06', portions: 0 }]), [OFFICE], NOW)
    expect(r.lines[0].status).toBe('ok')
    expect(r.autoApply).toBe(true)
  })

  it('нет WEEKLY-конфига → ручная проверка', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-06', portions: 30 }]), [], NOW)
    expect(r.autoApply).toBe(false)
    expect(r.reviewReasons).toContain('у клиента нет активного недельного питания')
  })
})

describe('даты', () => {
  it('parseItemDate → UTC-полночь календарной даты', () => {
    expect(parseItemDate('2026-10-06')).toEqual(new Date('2026-10-06T00:00:00.000Z'))
    expect(parseItemDate('2026-13-01')).toBeNull()
  })

  it('mondayOf: понедельник недели @db.Date-дня', () => {
    expect(mondayOf(new Date('2026-10-08T00:00:00.000Z'))).toEqual(new Date('2026-10-05T00:00:00.000Z'))
    expect(mondayOf(new Date('2026-10-11T00:00:00.000Z'))).toEqual(new Date('2026-10-05T00:00:00.000Z'))
    expect(mondayOf(new Date('2026-10-05T00:00:00.000Z'))).toEqual(new Date('2026-10-05T00:00:00.000Z'))
  })

  it('formatWeeklyDate: «пн 5 окт»', () => {
    expect(formatWeeklyDate('2026-10-05')).toBe('пн 5 окт')
    expect(formatWeeklyDate('2026-10-11')).toBe('вс 11 окт')
  })
})

describe('classifyWeeklyItems — «добавьте / уберите» (mode=add, 07.10)', () => {
  // вт 6 окт 16:23 МСК — как у ИНПАРТ АВТО: приём на ср 7 окт уже закрыт.
  const TUE_1623 = new Date('2026-10-06T13:23:00.000Z')
  const existing = new Map([
    ['loc_office:LUNCH:2026-10-07', 34],
    ['loc_office:LUNCH:2026-10-08', 34],
    ['loc_office:LUNCH:2026-10-09', 34],
  ])

  it('«С 07 октября добавьте 1 обед»: 7-е закрыто, 8-е и 9-е 34 → 35, можно автоматически', () => {
    const r = classifyWeeklyItems(
      parsed(
        ['2026-10-07', '2026-10-08', '2026-10-09'].map((date) => ({ date, portions: 1, mode: 'add' as const })),
        0.9,
      ),
      [OFFICE],
      TUE_1623,
      existing,
    )
    expect(r.lines.map((l) => [l.date, l.status, l.portions, l.prevPortions, l.delta, l.note])).toEqual([
      ['2026-10-07', 'skip', 1, null, 1, 'приём на эту дату уже закрыт'],
      ['2026-10-08', 'ok', 35, 34, 1, null],
      ['2026-10-09', 'ok', 35, 34, 1, null],
    ])
    expect(r.autoApply).toBe(true)
  })

  it('прибавка к дню без заказа → пропуск с причиной; убрать больше, чем есть → нужна проверка', () => {
    const r = classifyWeeklyItems(
      parsed([
        { date: '2026-10-12', portions: 2, mode: 'add' },
        { date: '2026-10-08', portions: -40, mode: 'add' },
      ]),
      [OFFICE],
      TUE_1623,
      existing,
    )
    expect(r.lines[0]).toMatchObject({ status: 'skip', note: 'заказа на этот день нет — не к чему прибавить' })
    expect(r.lines[1]).toMatchObject({ status: 'blocked', note: 'в заказе 34, убрать 40 нельзя' })
    expect(r.autoApply).toBe(false)
  })

  it('итоговое число показывает «было» из заказа (для «34 → 30»)', () => {
    const r = classifyWeeklyItems(parsed([{ date: '2026-10-08', portions: 30 }]), [OFFICE], TUE_1623, existing)
    expect(r.lines[0]).toMatchObject({ status: 'ok', portions: 30, prevPortions: 34, delta: null })
  })
})
