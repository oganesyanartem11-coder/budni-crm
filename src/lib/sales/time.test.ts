import { describe, it, expect } from 'vitest'
import { atMsk, nextContactSlot, quickSlots, plusOneDay, fromMskInput, toMskInput } from './time'

/**
 * МСК = UTC+3 (без DST). Входы — UTC-инстанты, соответствующие нужному МСК-времени:
 * МСК 2026-09-24 08:59 = 2026-09-24T05:59:00Z. 24.09.2026 — четверг.
 */
const iso = (d: Date | null) => d?.toISOString() ?? null

describe('atMsk', () => {
  it('сегодня/завтра/+3 дня на МСК-время', () => {
    const now = new Date('2026-09-24T11:00:00.000Z') // 14:00 МСК
    expect(iso(atMsk(0, '09:30', now))).toBe('2026-09-24T06:30:00.000Z')
    expect(iso(atMsk(1, '10:00', now))).toBe('2026-09-25T07:00:00.000Z')
    expect(iso(atMsk(3, '10:00', now))).toBe('2026-09-27T07:00:00.000Z')
  })

  it('кривое время → бросает', () => {
    expect(() => atMsk(0, '9', new Date())).toThrow()
  })
})

describe('nextContactSlot', () => {
  it('08:59 МСК → сегодня 09:30', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T05:59:00.000Z')))).toBe('2026-09-24T06:30:00.000Z')
  })
  it('09:00 МСК → +15 мин', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T06:00:00.000Z')))).toBe('2026-09-24T06:15:00.000Z')
  })
  it('17:29 МСК → +15 мин', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T14:29:00.000Z')))).toBe('2026-09-24T14:44:00.000Z')
  })
  it('19:59 МСК → +15 мин (ещё рабочее время)', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T16:59:00.000Z')))).toBe('2026-09-24T17:14:00.000Z')
  })
  it('20:00 МСК → завтра 09:30', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T17:00:00.000Z')))).toBe('2026-09-25T06:30:00.000Z')
  })
  it('23:30 МСК → завтра 09:30', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T20:30:00.000Z')))).toBe('2026-09-25T06:30:00.000Z')
  })
  it('21:00 UTC (= 00:00 МСК следующего дня) → «сегодня» по МСК 09:30', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T21:00:00.000Z')))).toBe('2026-09-25T06:30:00.000Z')
  })
  it('23:59 UTC (= 02:59 МСК) → МСК-сегодня 09:30, не послезавтра', () => {
    expect(iso(nextContactSlot(new Date('2026-09-24T23:59:00.000Z')))).toBe('2026-09-25T06:30:00.000Z')
  })
})

describe('quickSlots', () => {
  it('17:29 МСК → есть «сегодня 18:00»', () => {
    const s = quickSlots(new Date('2026-09-24T14:29:00.000Z'))
    expect(iso(s.inOneHour)).toBe('2026-09-24T15:29:00.000Z')
    expect(iso(s.todayEvening)).toBe('2026-09-24T15:00:00.000Z')
    expect(iso(s.tomorrow10)).toBe('2026-09-25T07:00:00.000Z')
    expect(iso(s.in3days10)).toBe('2026-09-27T07:00:00.000Z')
  })
  it('17:30 МСК → «сегодня 18:00» нет', () => {
    expect(quickSlots(new Date('2026-09-24T14:30:00.000Z')).todayEvening).toBeNull()
  })
  it('22:30 UTC (= 01:30 МСК) → «завтра» и «сегодня» считаются от МСК-дня', () => {
    const s = quickSlots(new Date('2026-09-24T22:30:00.000Z'))
    expect(iso(s.todayEvening)).toBe('2026-09-25T15:00:00.000Z')
    expect(iso(s.tomorrow10)).toBe('2026-09-26T07:00:00.000Z')
  })
})

describe('plusOneDay', () => {
  it('то же МСК-время, следующий МСК-день (через полночь UTC)', () => {
    expect(iso(plusOneDay(new Date('2026-09-24T21:30:00.000Z')))).toBe('2026-09-25T21:30:00.000Z')
  })
  it('переход месяца', () => {
    expect(iso(plusOneDay(new Date('2026-09-30T07:00:00.000Z')))).toBe('2026-10-01T07:00:00.000Z')
  })
})

describe('fromMskInput / toMskInput', () => {
  it('поля формы (МСК) → UTC и обратно', () => {
    expect(iso(fromMskInput('2026-09-25', '10:00'))).toBe('2026-09-25T07:00:00.000Z')
    expect(toMskInput(new Date('2026-09-24T21:30:00.000Z'))).toEqual({ date: '2026-09-25', time: '00:30' })
  })
  it('мусор → null', () => {
    expect(fromMskInput('25.09.2026', '10:00')).toBeNull()
    expect(fromMskInput('2026-09-25', '')).toBeNull()
  })
})
